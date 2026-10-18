/**
 * deliverPullRequest — the last mile of the issue→PR pipeline.
 *
 * Called by executeRun AFTER a successful run, while the sandbox is still
 * alive (the repo lives there). Two writes, in order:
 *
 *   1. git: push HEAD → refs/heads/harness/* (never the base branch; the
 *      sandbox layer already installed git credentials, so `git push origin`
 *      just works — for GitHub and for a local bare origin in tests)
 *   2. API: open the PR with a trace link back to the dashboard
 *
 * Then the thread records prNumber/prUrl and moves to `pr_open`. The first
 * delivery opens the PR; follow-ups (PR already open — babysitting) just
 * update the branch: the push IS the delivery.
 *
 * THE LOOP GUARD (learned live, 2026-10-18): a delivery only pushes when the
 * staged TREE differs from the remote branch's tree. Trees, not commits —
 * the engine's checkpoints are resume points that commit at every phase
 * boundary even when nothing changed, and pushing those made a push webhook
 * whose acknowledgment run delivered again: 8 no-op runs round-tripping
 * each other. A no-op delivery now pushes NOTHING, so the cycle terminates.
 */
import { eq } from "drizzle-orm";
import type { Sandbox } from "@harness/agent";
import { schema, type Db } from "../db/index.js";
import type { Thread } from "../db/schema.js";
import { ensureThreadState } from "../threads/state.js";
import type { GitHubClient } from "./client.js";
import { assertSafeHeadRef, headRefFor } from "./repo.js";

export interface DeliverPullRequestDeps {
  db: Db;
  sandbox: Sandbox;
  github: GitHubClient;
  thread: Thread;
  runId: string;
  publicUrl: string;
  summary?: string;
}

export interface DeliveredPullRequest {
  prNumber: number;
  prUrl: string;
  headRef: string;
}

export function traceUrl(publicUrl: string, threadId: string, runId: string): string {
  return `${publicUrl.replace(/\/+$/, "")}/threads/${threadId}?run=${runId}`;
}

export async function deliverPullRequest(deps: DeliverPullRequestDeps): Promise<DeliveredPullRequest | null> {
  const { db, sandbox, github, thread } = deps;

  const head = thread.headRef ?? headRefFor(thread.issueNumber);
  assertSafeHeadRef(head, thread.baseRef);

  // Is there anything to deliver? Stage everything, hash the working tree,
  // and compare against the remote branch's tree (refresh the tracking ref
  // first; missing branch = first delivery → there is work to push).
  await sandbox.exec("git add -A >/dev/null 2>&1", { timeoutSecs: 60 });
  await sandbox.exec(`git fetch --quiet origin "+refs/heads/${head}:refs/remotes/origin/${head}" 2>/dev/null || true`, {
    timeoutSecs: 120,
  });
  const localTree = await sandbox.exec("git write-tree", { timeoutSecs: 60 });
  const remoteTree = await sandbox.exec(`git rev-parse --verify --quiet "origin/${head}^{tree}" || true`, {
    timeoutSecs: 60,
  });
  const localTreeSha = localTree.stdout.trim();
  const remoteTreeSha = remoteTree.stdout.trim();
  const verified = localTree.exitCode === 0 && /^[0-9a-f]{40,64}$/.test(localTreeSha);
  const hasNewWork = !verified || remoteTreeSha === "" || localTreeSha !== remoteTreeSha;

  if (hasNewWork) {
    // Push — for a first delivery this creates the branch; for a FOLLOW-UP
    // (babysitting: the PR already exists) it updates it in place.
    // Force-pushing our own harness/* branch is the idempotent thing to do.
    const push = await sandbox.exec(`git push --force origin HEAD:refs/heads/${head}`, { timeoutSecs: 300 });
    if (push.exitCode !== 0) {
      throw new Error(`git push failed (${push.exitCode}): ${push.output.trim().slice(0, 500)}`);
    }
  }

  if (thread.prNumber) {
    // The PR exists: the push above IS the delivery (step 13) — or, when
    // there was nothing to push, this is a quiet no-op.
    return { prNumber: thread.prNumber, prUrl: thread.prUrl ?? "", headRef: head };
  }

  const issue = await github.getIssue(thread.repo, thread.issueNumber);
  const body = [
    `Fixes #${thread.issueNumber}`,
    "",
    "## 🤖 harness fix",
    deps.summary?.trim() ? deps.summary.trim() : "The agent completed the work on this issue.",
    "",
    `**Full trace:** ${traceUrl(deps.publicUrl, thread.id, deps.runId)}`,
  ].join("\n");
  const pr = await github.createPullRequest({
    repo: thread.repo,
    head,
    base: thread.baseRef,
    title: `Fix #${thread.issueNumber}: ${issue.title}`,
    body,
  });

  await db
    .update(schema.threads)
    .set({ prNumber: pr.number, prUrl: pr.html_url, headRef: head, updatedAt: new Date() })
    .where(eq(schema.threads.id, thread.id));
  await ensureThreadState(db, thread.id, "pr_open");

  return { prNumber: pr.number, prUrl: pr.html_url, headRef: head };
}
