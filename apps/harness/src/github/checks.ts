/**
 * PR-state helpers — pure interpretation of GitHub shapes for the babysitter.
 * No network here; these decide *meaning* (is this failure actionable? is this
 * comment unanswered?) from data the client already fetched.
 */

export interface CheckRunLike {
  name?: string;
  status?: string;
  conclusion?: string | null;
}

const NEUTRAL_CONCLUSIONS = ["success", "neutral", "skipped"];

/** Names of completed checks that did NOT succeed. */
export function failedCheckNames(runs: CheckRunLike[]): string[] {
  return runs
    .filter(
      (r) =>
        r.status === "completed" &&
        r.conclusion != null &&
        !NEUTRAL_CONCLUSIONS.includes(r.conclusion),
    )
    .map((r) => r.name ?? "check");
}

/** GitHub computes mergeability lazily; `false`/`dirty` means conflicted. */
export function prIsConflicted(pr: { mergeable?: boolean | null; mergeable_state?: string }): boolean {
  return pr.mergeable === false || pr.mergeable_state === "dirty";
}

export interface CommentLike {
  created_at?: string;
  body?: string | null;
  user?: { login?: string; type?: string };
}

/**
 * Human comments newer than the thread's last run — i.e. nothing has consumed
 * them yet (webhooks usually get there first; the sweep is the safety net).
 */
export function unansweredComments(
  comments: CommentLike[],
  since: Date | undefined,
  botLogin: string | undefined,
): CommentLike[] {
  return comments.filter((c) => {
    if (!c.created_at) return false;
    if (since !== undefined && new Date(c.created_at).getTime() <= since.getTime()) return false;
    if (botLogin !== undefined && c.user?.login === botLogin) return false;
    return true;
  });
}
