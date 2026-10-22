/** Pushes: our own work is acknowledged, anything else is ignored. */
import { isTerminal } from "../threads/state.js";
import { findThreadByHeadRef, deliverTurn, ignored, reply, type WebhookResult } from "./webhook-support.js";
import type { WebhookDeps } from "./webhook-support.js";
import type { PushEvent } from "./events.js";

export async function handlePush(
  deps: WebhookDeps,
  event: PushEvent,
  deliveryId: string,
  log: (line: string) => void,
): Promise<WebhookResult> {
  const repo = event.repository?.full_name;
  if (!repo || !event.ref?.startsWith("refs/heads/") || event.deleted === true)
    return ignored("not a branch push");
  if (deps.botLogin === undefined || event.sender?.login !== deps.botLogin) {
    return ignored("not our push");
  }
  const headRef = event.ref.slice("refs/heads/".length);
  const thread = await findThreadByHeadRef(deps, repo, headRef);
  if (!thread) return ignored("no thread for this branch");
  if (isTerminal(thread.state)) return ignored(`thread is ${thread.state}`);

  const payload = {
    ref: headRef,
    commits: Array.isArray(event.commits) ? event.commits.length : 0,
    headSha: event.after,
  };
  const { runId } = await deliverTurn(
    deps,
    thread,
    {
      deliveryId,
      kind: "push",
      payload,
      trigger: "inbox",
      cancelActive: false,
    },
    log,
  );
  log(
    `webhook: our push (${payload.commits} commit(s)) on ${headRef} → thread ${thread.id} ${runId ? `→ run ${runId}` : "→ parked"}`,
  );
  return reply({ threadId: thread.id, runId }, 202);
}
