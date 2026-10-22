/** Human feedback on a PR: reviews and review comments interject the run. */
import { isTerminal } from "../threads/state.js";
import { findThreadByIssue, findThreadByPr, deliverTurn, ignored, reply, type WebhookResult } from "./webhook-support.js";
import type { WebhookDeps } from "./webhook-support.js";
import type { ReviewEvent, IssueCommentEvent } from "./events.js";

export async function handleReview(
  deps: WebhookDeps,
  eventName: string,
  event: ReviewEvent,
  deliveryId: string,
  log: (line: string) => void,
): Promise<WebhookResult> {
  if (eventName === "pull_request_review" && event.action !== "submitted")
    return ignored(`action ${event.action ?? "?"}`);
  if (eventName === "pull_request_review_comment" && event.action !== "created")
    return ignored(`action ${event.action ?? "?"}`);

  const repo = event.repository?.full_name;
  const prNumber = event.pull_request?.number;
  if (!repo || typeof prNumber !== "number")
    return reply(
      { error: "missing repository or pull_request.number" }, 400);
  const thread = await findThreadByPr(deps, repo, prNumber);
  if (!thread) return ignored("no thread for this PR");
  if (isTerminal(thread.state)) return ignored(`thread is ${thread.state}`);

  const author = event.review?.user?.login ?? event.comment?.user?.login;
  const self = deps.botLogin !== undefined && author === deps.botLogin;
  const payload = {
    state: event.review?.state,
    body: event.review?.body ?? event.comment?.body ?? "",
    author,
    self,
    url: event.review?.html_url ?? event.comment?.html_url,
    path: event.comment?.path,
    // The review comment's anchor and the code it sat on — the agent must see
    // the same context the reviewer did, never a bare sentence.
    line: event.comment?.line ?? event.comment?.original_line ?? undefined,
    side: event.comment?.side ?? undefined,
    subjectType: event.comment?.subject_type,
    diffHunk: event.comment?.diff_hunk,
    prNumber,
    prTitle: event.pull_request?.title,
    prUrl: event.pull_request?.html_url,
  };
  const { runId } = await deliverTurn(
    deps,
    thread,
    {
      deliveryId,
      kind:
        eventName === "pull_request_review"
          ? "pull_request_review"
          : "pull_request_review_comment",
      payload,
      trigger: "review",
      cancelActive: !self, // reviews interject — ANY author (decision #28)
    },
    log,
  );
  log(
    `webhook: ${eventName} by ${author ?? "?"} → thread ${thread.id} ${runId ? `→ run ${runId}` : "→ parked (interject)"}`,
  );
  return reply({ threadId: thread.id, runId }, 202);
}

export async function handleComment(
  deps: WebhookDeps,
  event: IssueCommentEvent,
  deliveryId: string,
  log: (line: string) => void,
): Promise<WebhookResult> {
  if (event.action !== "created")
    return ignored(`action ${event.action ?? "?"}`);
  const repo = event.repository?.full_name;
  const issueNumber = event.issue?.number;
  if (!repo || typeof issueNumber !== "number")
    return reply(
      { error: "missing repository or issue.number" }, 400);

  const isPr = event.issue?.pull_request !== undefined;
  const thread = isPr
    ? await findThreadByPr(deps, repo, issueNumber)
    : await findThreadByIssue(deps, repo, issueNumber);
  if (!thread) return ignored("no thread for this comment");
  if (isTerminal(thread.state)) return ignored(`thread is ${thread.state}`);

  const author = event.comment?.user?.login;
  const self = deps.botLogin !== undefined && author === deps.botLogin;
  const human = event.comment?.user?.type === "User";
  const payload = {
    body: event.comment?.body ?? "",
    author,
    self,
    url: event.comment?.html_url,
    prNumber: issueNumber,
  };
  const { runId } = await deliverTurn(
    deps,
    thread,
    {
      deliveryId,
      kind: "issue_comment",
      payload,
      trigger: "babysit_comment",
      cancelActive: !self && human,
    },
    log,
  );
  log(
    `webhook: issue_comment by ${author ?? "?"} (${human ? "human" : "bot"}) → thread ${thread.id} ${runId ? `→ run ${runId}` : "→ parked"}`,
  );
  return reply({ threadId: thread.id, runId }, 202);
}
