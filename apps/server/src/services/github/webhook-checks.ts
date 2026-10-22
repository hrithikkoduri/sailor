/** CI signals: check_run and commit status outcomes become babysit turns. */
import { isTerminal } from "../threads/state.js";
import { findThreadByHeadRef, findThreadByPr, deliverTurn, ignored, reply, type WebhookResult } from "./webhook-support.js";
import type { WebhookDeps } from "./webhook.js";
import type { CheckRunEvent, StatusEvent } from "./events.js";

// --- step 13 handlers ---------------------------------------------------------

const FAILING_CONCLUSIONS = [
  "failure",
  "timed_out",
  "cancelled",
  "action_required",
  "startup_failure",
];

export async function handleCheckRun(
  deps: WebhookDeps,
  event: CheckRunEvent,
  deliveryId: string,
  log: (line: string) => void,
): Promise<WebhookResult> {
  if (event.action !== "completed")
    return ignored(`action ${event.action ?? "?"}`);
  const conclusion = event.check_run?.conclusion;
  if (!conclusion || !FAILING_CONCLUSIONS.includes(conclusion))
    return ignored(`conclusion ${conclusion ?? "none"}`);

  const repo = event.repository?.full_name;
  if (!repo)
    return reply(
      { error: "missing repository.full_name" }, 400);
  const prNumber = event.check_run?.pull_requests?.[0]?.number;
  const headRef = event.check_run?.check_suite?.head_branch;
  const thread = prNumber
    ? await findThreadByPr(deps, repo, prNumber)
    : headRef
      ? await findThreadByHeadRef(deps, repo, headRef)
      : undefined;
  if (!thread) return ignored("no thread for this check");
  if (isTerminal(thread.state)) return ignored(`thread is ${thread.state}`);

  const payload = {
    checks: [event.check_run?.name ?? "check"],
    url: event.check_run?.html_url,
    sha: event.check_run?.head_sha,
  };
  const { runId } = await deliverTurn(
    deps,
    thread,
    {
      deliveryId,
      kind: "check_run",
      payload,
      trigger: "babysit_ci",
      cancelActive: false,
    },
    log,
  );
  log(
    `webhook: check_run ${conclusion} → thread ${thread.id} ${runId ? `→ run ${runId}` : "→ parked"}`,
  );
  return reply({ threadId: thread.id, runId }, 202);
}

export async function handleStatus(
  deps: WebhookDeps,
  event: StatusEvent,
  deliveryId: string,
  log: (line: string) => void,
): Promise<WebhookResult> {
  if (event.state !== "failure" && event.state !== "error")
    return ignored(`state ${event.state ?? "?"}`);
  const repo = event.repository?.full_name;
  const headRef = event.branches?.[0]?.name;
  if (!repo || !headRef) return ignored("no branch on this status");
  const thread = await findThreadByHeadRef(deps, repo, headRef);
  if (!thread) return ignored("no thread for this status");
  if (isTerminal(thread.state)) return ignored(`thread is ${thread.state}`);

  const payload = {
    checks: [event.context ?? "status"],
    url: event.target_url,
    sha: event.commit?.sha,
  };
  const { runId } = await deliverTurn(
    deps,
    thread,
    {
      deliveryId,
      kind: "status",
      payload,
      trigger: "babysit_ci",
      cancelActive: false,
    },
    log,
  );
  log(
    `webhook: status ${event.state} → thread ${thread.id} ${runId ? `→ run ${runId}` : "→ parked"}`,
  );
  return reply({ threadId: thread.id, runId }, 202);
}
