/**
 * The webhook door — GitHub events in, threads and turns out.
 *
 * Order of defenses, on purpose:
 *   1. HMAC-verify the RAW body (nothing is parsed before this check)
 *   2. delivery-GUID ledger — GitHub delivers at-least-once; the ledger makes
 *      retries exactly-once
 *   3. handler routing: issues:labeled opens threads; check_run/status → queue;
 *      reviews and human comments → interject; our own pushes → queue +
 *      acknowledge; pull_request closed → terminal thread state.
 *
 * The server only writes Postgres + the queue — the worker executes runs.
 */
import { and, desc, eq, inArray } from "drizzle-orm";
import { schema, type Db } from "../../db/index.js";
import { verifyWebhookSignature } from "../../services/github/signature.js";
import { AGENT_FIX_LABEL, classifyGithubEvent } from "../../services/github/triage.js";
import { renderGithubTask } from "../../services/github/render.js";
import { headRefFor } from "../../services/github/repo.js";
import { repoEnabled, upsertInstallation } from "../../services/github/installations.js";
import { appendEvent, consumeEvents } from "../../services/threads/inbox.js";
import { canTransition, isTerminal } from "../../services/threads/state.js";
import { wakeThread } from "../../services/threads/wake.js";
import { requestCancel } from "../../services/runs/lease.js";
import { releaseThreadSandbox } from "../../services/runs/execute.js";
import type { StreamHub } from "../../http/stream.js";
import type { Queues } from "../../queue/index.js";

import { reply, type WebhookDeps, type WebhookResult } from "./webhook-support.js";
import type { LabeledEvent, CheckRunEvent, StatusEvent, ReviewEvent, IssueCommentEvent, PushEvent, PullRequestEvent } from "./events.js";
import { handleCheckRun, handleStatus } from "./webhook-checks.js";
import { handleReview, handleComment } from "./review.js";
import { handlePush } from "./push.js";
import { handlePullRequest } from "./pull-request.js";
import { handleIssueLabeled } from "./issue.js";
import { handleInstallationEvent } from "./installation.js";

/** The subset of server dependencies the webhook door needs. */
export type { WebhookDeps, WebhookResult } from "./webhook-support.js";
export { reply } from "./webhook-support.js";

export async function handleGithubWebhook(
  deps: WebhookDeps,
  input: { rawBody: string; eventName: string; deliveryId: string; signature: string | undefined },
): Promise<WebhookResult> {
  const log = deps.log ?? (() => undefined);
    const { rawBody, eventName, deliveryId, signature } = input;

    if (
      !deps.skipSignatureVerification &&
      !verifyWebhookSignature(
        deps.webhookSecret,
        rawBody,
        signature,
      )
    ) {
      log(`webhook: REJECTED bad signature (event=${eventName || "?"})`);
      return reply({ error: "invalid signature" }, 401);
    }
    if (!deliveryId)
      return reply({ error: "missing X-GitHub-Delivery header" }, 400);

    const inserted = await deps.db
      .insert(schema.webhookDeliveries)
      .values({ deliveryId, eventKind: eventName })
      .onConflictDoNothing()
      .returning();
    if (inserted.length === 0) {
      log(
        `webhook: duplicate delivery ${deliveryId} (${eventName}) — acknowledged`,
      );
      return reply({ duplicate: true }, 200);
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(rawBody) as Record<string, unknown>;
    } catch {
      return reply({ error: "body is not JSON" }, 400);
    }

    if (eventName === "ping") {
      log(`webhook: ping ok (${deliveryId})`);
      return reply({ pong: true }, 200);
    }

    // --- installation lifecycle: manages the gate itself ---------------------
    if (
      eventName === "installation" ||
      eventName === "installation_repositories"
    ) {
      return handleInstallationEvent(deps, eventName, payload, log);
    }

    // --- THE REPO GATE (decision #44) ----------------------------------------
    // Only repos selected during onboarding may trigger agent runs. Everything
    // else is recorded in the delivery ledger and ignored — cheap by design.
    const installationId = (payload as { installation?: { id?: number } })
      .installation?.id;
    const repoFullName = (payload as { repository?: { full_name?: string } })
      .repository?.full_name;
    if (typeof installationId !== "number" || !repoFullName) {
      log(
        `webhook: ${eventName} without installation/repository — ignored (App-only mode)`,
      );
      return reply({ ignored: true, reason: "missing installation" }, 202);
    }
    if (!(await repoEnabled(deps.db, installationId, repoFullName))) {
      log(
        `webhook: ${eventName} for ${repoFullName} — repo not enabled in onboarding, ignored`,
      );
      return reply({ ignored: true, reason: "repo not enabled" }, 202);
    }

    // --- the door (step 12): labeled agent:fix → thread → run --------------
    if (
      eventName === "issues" &&
      (payload as LabeledEvent).action === "labeled"
    ) {
      const event = payload as LabeledEvent;
      if (event.label?.name === AGENT_FIX_LABEL) {
        return handleIssueLabeled(deps, event, deliveryId, log);
      }
    }

    // --- step 13: the PR lifecycle ------------------------------------------
    if (eventName === "check_run")
      return handleCheckRun(deps, payload as CheckRunEvent, deliveryId, log);
    if (eventName === "status")
      return handleStatus(deps, payload as StatusEvent, deliveryId, log);
    if (
      eventName === "pull_request_review" ||
      eventName === "pull_request_review_comment"
    )
      return handleReview(
        deps,
        eventName,
        payload as ReviewEvent,
        deliveryId,
        log,
      );
    if (eventName === "issue_comment")
      return handleComment(deps, payload as IssueCommentEvent, deliveryId, log);
    if (eventName === "push")
      return handlePush(deps, payload as PushEvent, deliveryId, log);
    if (eventName === "pull_request")
      return handlePullRequest(
        deps,
        payload as PullRequestEvent,
        deliveryId,
        log,
      );

    // Everything else: recorded + triaged (decision #28), no handler yet.
    const decision = classifyGithubEvent(eventName, payload, {
      botLogin: deps.botLogin,
    });
    log(
      `webhook: ${eventName} → ${decision.action} (${decision.reason}) — no handler`,
    );
    return reply({ ignored: true, triage: decision }, 202);
}

