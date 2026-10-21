/**
 * deliverPullRequest — the last mile of the issue→PR pipeline.
 *
 * Called by executeRun AFTER a successful run, while the sandbox is still
 * alive (the repo lives there). Two writes, in order:
 *
 *   1. git: push a CLEAN commit → refs/heads/sailor/* (never the base
 *      branch; the sandbox layer already installed git credentials, so
 *      `git push origin` just works — for GitHub and for a local bare origin
 *      in tests). The published commit is HEAD's tree minus `.anchor/` —
 *      agent scratch rides checkpoints for durability, never the deliverable
 *      — parented on the base's tip: one reviewable commit per delivery.
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
import { shq, type Sandbox } from "anchor-ai-sdk";
import { schema, type Db } from "../db/index.js";
import type { Thread } from "../db/schema.js";
import { ensureThreadState } from "../threads/state.js";
import type { GitHubClient } from "./client.js";
import { assertSafeHeadRef, headRefForThread } from "./repo.js";

export interface DeliverPullRequestDeps {
  db: Db;
  sandbox: Sandbox;
  github: GitHubClient;
  thread: Thread;
  runId: string;
  publicUrl: string;
  summary?: string;
  verification?: string;
  draft?: boolean;
  gitToken?: () => Promise<string>;
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

  if (!["github", "manual"].includes(thread.source))
    throw new Error("Attach a GitHub repository before publishing changes.");
  const head = headRefForThread(thread);
  assertSafeHeadRef(head, thread.baseRef);

  // Is there anything to DELIVER? Ask the sandbox by CONTENT — trees, never
  // commits (Sandbox.hasChangesFrom): checkpoints create commits at phase
  // boundaries without content changes, and pushing those fired a push
  // webhook whose acknowledgment run delivered again (the 2026-10-18 loop).
  // Nothing new → no push → no webhook → no loop.
  const hasNewWork = await sandbox.hasChangesFrom(`origin/${head}`);
  if (hasNewWork) {
    // A repository attached mid-run was fetched with a command-scoped token,
    // not stored credentials. Publication uses the same ephemeral boundary.
    const token = await deps.gitToken?.();
    const git = token
      ? "git -c 'credential.helper=!f() { echo username=x-access-token; printf \"password=%s\\n\" \"$GIT_TOKEN\"; }; f'"
      : "git";
    // Publish ONE CLEAN commit: the agent's scratch (`.anchor/notes.md`) is
    // force-added by every checkpoint for durability, so the work branch's
    // history carries it — and the dev's repo must never see it. The notes
    // stay in the sandbox and on the off-machine checkpoint branch; the
    // published branch is HEAD's tree minus `.anchor/`, parented on the
    // base's tip. Stable for a first delivery AND for follow-ups (the PR
    // updates in place; never a second PR).
    const script = [
      "set -e",
      `if ${git} fetch --quiet origin ${shq(thread.baseRef)} 2>/dev/null; then BASE=$(git rev-parse FETCH_HEAD);`,
      `else BASE=$(git rev-parse --verify --quiet refs/remotes/origin/${shq(thread.baseRef)} || git rev-parse --verify --quiet ${shq(thread.baseRef)} || true); fi`,
      "git read-tree HEAD",
      "git rm -rq --cached --ignore-unmatch .anchor",
      "CLEAN_TREE=$(git write-tree)",
      "git read-tree HEAD",
      'MSG=$(git log -1 --format=%B HEAD)',
      'if [ -n "$BASE" ]; then CLEAN_COMMIT=$(git commit-tree "$CLEAN_TREE" -p "$BASE" -m "$MSG"); else CLEAN_COMMIT=$(git commit-tree "$CLEAN_TREE" -m "$MSG"); fi',
      `${git} push --force origin "$CLEAN_COMMIT:refs/heads/${head}"`,
      'echo "published $CLEAN_COMMIT"',
    ].join("\n");
    const push = await sandbox.exec(script, { timeoutSecs: 300, ...(token ? { env: { GIT_TOKEN: token } } : {}) });
    if (push.exitCode !== 0) {
      throw new Error(`git push failed (${push.exitCode}): ${push.output.trim().slice(0, 500)}`);
    }
  }

  if (thread.prNumber) {
    // The PR exists: the push above IS the delivery (step 13) — or, when
    // there was nothing to push, this is a quiet no-op.
    return { prNumber: thread.prNumber, prUrl: thread.prUrl ?? "", headRef: head };
  }

  const issue = thread.source === "github"
    ? await github.getIssue(thread.repo, thread.issueNumber) : undefined;
  const title = issue ? `Fix #${thread.issueNumber}: ${issue.title}`
    : thread.title?.trim() || deps.summary?.trim().split("\n")[0] || "Update repository";
  const body = [
    ...(issue ? [`Fixes #${thread.issueNumber}`, ""] : []),
    "## 🤖 sailor changes",
    deps.summary?.trim() ? deps.summary.trim() : "The agent completed the requested repository changes.",
    ...(deps.verification ? ["", `**Verification:** ${deps.verification}`] : []),
    "",
    `**Full trace:** ${traceUrl(deps.publicUrl, thread.id, deps.runId)}`,
  ].join("\n");
  const pr = await github.createPullRequest({
    repo: thread.repo,
    head,
    base: thread.baseRef,
    title: title.slice(0, 256),
    body,
    ...(deps.draft !== undefined ? { draft: deps.draft } : {}),
  });

  await db
    .update(schema.threads)
    .set({ prNumber: pr.number, prUrl: pr.html_url, headRef: head, updatedAt: new Date() })
    .where(eq(schema.threads.id, thread.id));
  await ensureThreadState(db, thread.id, "pr_open");

  return { prNumber: pr.number, prUrl: pr.html_url, headRef: head };
}
