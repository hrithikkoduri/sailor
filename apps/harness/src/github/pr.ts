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
 * Then the thread records prNumber/prUrl and moves to `pr_open`. Idempotent
 * by gate: a thread that already has a PR is left alone (follow-up pushes to
 * an open PR are step 13's job).
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
  if (thread.prNumber) return null; // a PR is already open for this thread

  const head = thread.headRef ?? headRefFor(thread.issueNumber);
  assertSafeHeadRef(head, thread.baseRef);

  // The branch may exist from a previous delivery attempt — force-pushing our
  // own harness/* branch is the idempotent thing to do.
  const push = await sandbox.exec(`git push --force origin HEAD:refs/heads/${head}`, { timeoutSecs: 300 });
  if (push.exitCode !== 0) {
    throw new Error(`git push failed (${push.exitCode}): ${push.output.trim().slice(0, 500)}`);
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
