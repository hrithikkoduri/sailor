/**
 * Triage — the routing decision from decision #28, as a pure function.
 *
 * The axes: **self vs external** (is the sender our own bot?) + what the
 * event means.
 *   - self events        → queue (not suppressed; rendered as "acknowledge")
 *   - external REVIEWS   → interject (ANY author — a review bot's review is
 *                          real feedback and can redirect the work)
 *   - human messages     → interject
 *   - everything machine → queue (same goal as the running work)
 *
 * Step 12 wires only `issues: labeled` (the thread opener); steps 13/18 wire
 * the rest to this same classifier. The explicit Interject button bypasses it
 * entirely (a human overrules the router).
 */
export const AGENT_FIX_LABEL = "agent:fix";

export type TriageAction = "interject" | "queue";

export interface TriageDecision {
  action: TriageAction;
  kind: string;
  reason: string;
}

interface Sender {
  login?: string;
  type?: string;
}

export function classifyGithubEvent(
  eventName: string,
  payload: Record<string, unknown>,
  opts: { botLogin?: string } = {},
): TriageDecision {
  const sender = payload.sender as Sender | undefined;
  const self = opts.botLogin !== undefined && sender?.login === opts.botLogin;

  if (self) {
    return {
      action: "queue",
      kind: eventName,
      reason: "self-authored — not suppressed; render as acknowledge (decision #28)",
    };
  }

  switch (eventName) {
    case "pull_request_review":
    case "pull_request_review_comment":
      return { action: "interject", kind: eventName, reason: "review feedback (any author) can redirect the work" };
    case "issue_comment":
    case "pull_request":
      return sender?.type === "User"
        ? { action: "interject", kind: eventName, reason: "human message — heard now" }
        : { action: "queue", kind: eventName, reason: "machine/bot activity" };
    default:
      return { action: "queue", kind: eventName, reason: "machine event" };
  }
}
