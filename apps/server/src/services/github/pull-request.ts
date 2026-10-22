/** The PR lifecycle: a merged/closed PR moves the thread to a terminal state. */
import { and, eq } from "drizzle-orm";
import { schema } from "../../db/index.js";
import { canTransition, isTerminal } from "../threads/state.js";
import { requestCancel } from "../runs/lease.js";
import { releaseThreadSandbox } from "../runs/execute.js";
import { activeRun, findThreadByPr, ignored, reply, type WebhookResult } from "./webhook-support.js";
import type { WebhookDeps } from "./webhook-support.js";
import type { PullRequestEvent } from "./events.js";

export async function handlePullRequest(
  deps: WebhookDeps,
  event: PullRequestEvent,
  _deliveryId: string,
  log: (line: string) => void,
): Promise<WebhookResult> {
  const repo = event.repository?.full_name;
  const pr = event.pull_request;
  if (!repo || typeof pr?.number !== "number")
    return reply(
      { error: "missing repository or pull_request.number" }, 400);
  if (event.action !== "closed")
    return ignored(`action ${event.action ?? "?"}`);

  const thread = await findThreadByPr(deps, repo, pr.number);
  if (!thread) return ignored("no thread for this PR");
  if (isTerminal(thread.state)) return ignored(`thread is ${thread.state}`);

  const to = pr.merged ? "merged" : "closed";
  const target = canTransition(thread.state, to)
    ? to
    : canTransition(thread.state, "closed")
      ? "closed"
      : undefined;
  if (!target) return ignored(`no ${to} transition from ${thread.state}`);

  const active = await activeRun(deps, thread.id);
  if (active) await requestCancel(deps.db, active.id); // the work is moot now
  await deps.db
    .update(schema.threads)
    .set({ state: target, updatedAt: new Date() })
    .where(eq(schema.threads.id, thread.id));
  deps.hub?.notify(thread.id);
  // The issue is finished — release the retained sandbox (A). Best-effort.
  await releaseThreadSandbox(deps.db, thread).catch(() => undefined);
  log(`webhook: PR #${pr.number} ${target} → thread ${thread.id}`);
  return reply({ threadId: thread.id, state: target }, 200);
}
