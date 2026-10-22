/**
 * The PR babysitter — the safety net for what GitHub doesn't announce (and
 * what webhooks miss).
 *
 * Runs every BABYSIT_REPEAT_MS (or targeted at one thread) and, for each open
 * agent PR, checks four things:
 *   - the PR was merged/closed   → transition the thread to its terminal state
 *   - merge conflicts            → wake a turn (NO webhook exists for this)
 *   - failed CI checks           → wake a turn (queue semantics, #28)
 *   - unanswered human comments  → wake a turn (interject semantics, #28)
 *
 * `threads.watch` (decision #31) narrows what to look for. Budgets cap the
 * spend (max turns/$ per thread). A thread with an active run is left alone —
 * that run (plus the post-turn inbox drain) owns the turn.
 */
import { and, desc, eq, inArray } from "drizzle-orm";
import { schema, type Db } from "../db/index.js";
import type { Queues } from "../queue/index.js";
import type { GitHubClient } from "../services/github/client.js";
import type { GitHubAppService } from "../services/github/app.js";
import { failedCheckNames, prIsConflicted, unansweredComments } from "../services/github/checks.js";
import { renderGithubTask } from "../services/github/render.js";
import { appendEvent, consumeEvents, pendingEvents } from "../services/threads/inbox.js";
import { canTransition } from "../services/threads/state.js";
import { wakeThread } from "../services/threads/wake.js";
import { requestCancel } from "../services/runs/lease.js";

export interface BabysitDeps {
  db: Db;
  queues: Queues;
  /** Tokens are minted per installation (decision #42). */
  githubApp: GitHubAppService;
  botLogin?: string;
}

export interface BabysitResult {
  threadId: string;
  action: string; // terminal | busy | budget | conflict | ci_failed | comments | quiet | error: …
}

type ThreadRow = typeof schema.threads.$inferSelect;

export async function runBabysitSweep(
  deps: BabysitDeps,
  opts: { threadId?: string } = {},
): Promise<BabysitResult[]> {
  const open = await deps.db
    .select()
    .from(schema.threads)
    .where(
      opts.threadId
        ? eq(schema.threads.id, opts.threadId)
        : inArray(schema.threads.state, ["pr_open", "waiting_ci", "fixing", "addressing_comments"]),
    );

  const results: BabysitResult[] = [];
  for (const thread of open) {
    if (thread.prNumber == null) continue;
    try {
      if (thread.installationId == null) {
        results.push({ threadId: thread.id, action: "no-installation" });
        continue;
      }
      const github = await deps.githubApp.clientFor(thread.installationId);
      results.push(await babysitOne({ ...deps, github }, thread));
    } catch (err) {
      results.push({
        threadId: thread.id,
        action: `error: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }
  return results;
}

async function babysitOne(
  deps: BabysitDeps & { github: GitHubClient },
  thread: ThreadRow,
): Promise<BabysitResult> {
  const { db, github } = deps;

  const pr = await github.getPullRequest(thread.repo, thread.prNumber!);

  // Terminal first: a merged/closed PR ends the thread's life (and cancels
  // any run still grinding on now-moot work).
  if (pr.state === "closed") {
    const to = pr.merged ? "merged" : "closed";
    const target = canTransition(thread.state, to) ? to : canTransition(thread.state, "closed") ? "closed" : undefined;
    if (!target) return { threadId: thread.id, action: "quiet" };
    const active = await activeRun(db, thread.id);
    if (active) await requestCancel(db, active.id);
    await db
      .update(schema.threads)
      .set({ state: target, updatedAt: new Date() })
      .where(eq(schema.threads.id, thread.id));
    return { threadId: thread.id, action: target };
  }

  // One turn at a time: while a run owns the thread, defer to it (the
  // post-turn drain will pick up anything the webhooks parked).
  if (await activeRun(db, thread.id)) return { threadId: thread.id, action: "busy" };

  const budgetOk =
    thread.turnsUsed < thread.budgetMaxTurns && Number(thread.usdSpent) < Number(thread.budgetMaxUsd);
  const pending = await pendingEvents(db, thread.id);
  const hasPending = (kind: string) => pending.some((e) => e.kind === kind);
  const watch = (thread.watch ?? {}) as Record<string, unknown>;
  const watchChecks = watch.checks !== false;
  const watchComments = watch.comments !== false;

  // Merge conflicts — the condition with no webhook. Only a sweep notices.
  if (prIsConflicted(pr)) {
    if (!budgetOk) return { threadId: thread.id, action: "budget" };
    if (hasPending("pr_conflict")) return { threadId: thread.id, action: "quiet" };
    await enqueue(deps, thread, "pr_conflict", { base: thread.baseRef, url: pr.html_url }, false);
    return { threadId: thread.id, action: "conflict" };
  }

  // Failed CI on the PR head.
  if (watchChecks) {
    const runs = await github.getCheckRuns(thread.repo, pr.head.sha);
    const failed = failedCheckNames(runs);
    if (failed.length > 0) {
      if (!budgetOk) return { threadId: thread.id, action: "budget" };
      if (hasPending("check_run")) return { threadId: thread.id, action: "quiet" };
      await enqueue(
        deps,
        thread,
        "check_run",
        { checks: failed, url: pr.html_url, sha: pr.head.sha, headRef: pr.head.ref },
        false,
      );
      return { threadId: thread.id, action: "ci_failed" };
    }
  }

  // Unanswered human comments newer than the thread's last run.
  if (watchComments) {
    const comments = await github.listIssueComments(thread.repo, thread.prNumber!);
    const lastRunAt = await latestRunAt(db, thread.id);
    const unanswered = unansweredComments(comments, lastRunAt, deps.botLogin);
    if (unanswered.length > 0) {
      if (!budgetOk) return { threadId: thread.id, action: "budget" };
      if (hasPending("issue_comment")) return { threadId: thread.id, action: "quiet" };
      await enqueue(
        deps,
        thread,
        "issue_comment",
        {
          body: unanswered
            .map((c) => c.body ?? "")
            .join("\n\n")
            .slice(0, 4000),
          author: unanswered[0]?.user?.login,
          url: pr.html_url,
        },
        true, // human comments interject (decision #28)
      );
      return { threadId: thread.id, action: "comments" };
    }
  }

  return { threadId: thread.id, action: "quiet" };
}

/** Append the finding, optionally interject, wake (parked while busy). */
async function enqueue(
  deps: BabysitDeps,
  thread: ThreadRow,
  kind: string,
  payload: Record<string, unknown>,
  cancelActive: boolean,
): Promise<void> {
  const evt = await appendEvent(deps.db, { threadId: thread.id, kind, payload });
  if (cancelActive) {
    const active = await activeRun(deps.db, thread.id);
    if (active) await requestCancel(deps.db, active.id);
  }
  const trigger = kind === "issue_comment" ? "babysit_comment" : "babysit_ci";
  const run = await wakeThread(deps, thread.id, { trigger, task: renderGithubTask(kind, payload) });
  if (run) await consumeEvents(deps.db, [evt.id]);
}

async function activeRun(db: Db, threadId: string) {
  const [run] = await db
    .select({ id: schema.runs.id })
    .from(schema.runs)
    .where(and(eq(schema.runs.threadId, threadId), inArray(schema.runs.status, ["queued", "running"])))
    .orderBy(desc(schema.runs.createdAt))
    .limit(1);
  return run;
}

async function latestRunAt(db: Db, threadId: string): Promise<Date | undefined> {
  const [run] = await db
    .select({ createdAt: schema.runs.createdAt })
    .from(schema.runs)
    .where(eq(schema.runs.threadId, threadId))
    .orderBy(desc(schema.runs.createdAt))
    .limit(1);
  return run?.createdAt;
}
