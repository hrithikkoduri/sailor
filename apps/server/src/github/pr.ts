/**
 * deliverPullRequest — the last mile of the issue→PR pipeline.
 *
 * Called by executeRun AFTER a successful run, while the sandbox is still
 * alive (the repo lives there). Two writes, in order:
 *
 *   1. git: push HEAD → refs/heads/sailor/* (never the base branch; the
 *      sandbox layer already installed git credentials, so `git push origin`
 *      just works — for GitHub and for a local bare origin in tests)
 *   2. API: open the PR with a trace link back to the dashboard
 *
 * Then the thread records prNumber/prUrl and moves to `pr_open`. The first
 * delivery opens the PR; follow-ups (PR already open — babysitting) just
 * update the branch: the push IS the delivery.
 *
 * WHAT GETS DELIVERED (the 2026-10-18 loop guard): only when the CONTENT
 * changed — `sandbox.hasChangesFrom()` compares trees, never commit lists,
 * because the engine's checkpoints commit at every phase boundary without
 * changing content. A no-op delivery pushes NOTHING: no push webhook, no
 * acknowledgment wake, no feedback loop. (The trap is sealed in the Sandbox
 * interface now; this file just uses it.)
 */
import { eq } from "drizzle-orm";
import type { Sandbox } from "@anchor/core";
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

  // Is there anything to DELIVER? Ask the sandbox by CONTENT — trees, never
  // commits (Sandbox.hasChangesFrom): checkpoints create commits at phase
  // boundaries without content changes, and pushing those fired a push
  // webhook whose acknowledgment run delivered again (the 2026-10-18 loop).
  // Nothing new → no push → no webhook → no loop.
  const hasNewWork = await sandbox.hasChangesFrom(`origin/${head}`);
  if (hasNewWork) {
    // Push — for a first delivery this creates the branch; for a FOLLOW-UP
    // (babysitting: the PR already exists) it updates it in place.
    // Force-pushing our own sailor/* branch is the idempotent thing to do.
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
    "## 🤖 sailor fix",
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
