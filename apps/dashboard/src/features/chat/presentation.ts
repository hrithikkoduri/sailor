/**
 * How an inbox event appears in the conversation — one map to configure.
 *
 *   role:   "user"   → a human bubble (right-aligned).
 *           "system" → a quiet system line, expandable when it carries
 *                      details/snippet.
 *   hidden: true     → strictly hidden outside debug mode (⌘⇧D); in debug it
 *                      renders collapsed and expandable, tagged "hidden".
 *
 * Defaults: only messages written in OUR chat are user bubbles. Anything
 * external — GitHub reviews, comments, machine events — is a system receipt,
 * because the agent already acts on it and the thread must not fake a chat
 * message the human never sent. Change a line here to reclassify a kind.
 */
export interface EventPresentation {
  role: "user" | "system";
  hidden?: boolean;
}

export const EVENT_PRESENTATION: Record<string, EventPresentation> = {
  chat_message: { role: "user" },
  issue_comment: { role: "system" },
  pull_request_review: { role: "system" },
  pull_request_review_comment: { role: "system" },
  issue_labeled: { role: "system" },
  check_run: { role: "system" },
  status: { role: "system" },
  push: { role: "system" },
  pr_conflict: { role: "system" },
  budget_exhausted: { role: "system" },
  // Any kind can be { role: "system", hidden: true } to become debug-only.
};

export function presentationFor(kind: string): EventPresentation {
  return EVENT_PRESENTATION[kind] ?? { role: "system" };
}
