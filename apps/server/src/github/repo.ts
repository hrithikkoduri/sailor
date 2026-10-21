/**
 * Repo + ref helpers — pure, testable, boring on purpose.
 *
 * Threads store `repo` as a GitHub slug ("owner/name") or, in local dev, a
 * path; the `source` column is what disambiguates. The push guard here is
 * load-bearing: we only ever push `sailor/*` branches and never the base.
 */

/** "owner/name" shape — format only; `threads.source` decides GitHub-ness. */
export function isGithubSlug(repo: string): boolean {
  return (
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) && !repo.includes("://")
  );
}

export function githubRepoUrl(slug: string): string {
  return `https://github.com/${slug}.git`;
}

/** The one branch shape we push: sailor/issue-<n>. */
export function headRefFor(issueNumber: number): string {
  return `sailor/issue-${issueNumber}`;
}

/** Issue-free conversations use their stable thread ID, never the legacy placeholder issue number. */
export function headRefForThread(thread: { id: string; source: string; issueNumber: number; headRef: string | null }): string {
  return thread.headRef ?? (thread.source === "github"
    ? headRefFor(thread.issueNumber)
    : `sailor/thread-${thread.id}`);
}

const safeHead = /^(?:(sailor|harness)\/issue-\d+|sailor\/thread-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

/**
 * Never push to main — or anywhere that isn't one of OUR issue branches.
 * `sailor/*` is the current shape; `harness/*` is accepted because PRs opened
 * before the rename keep their branch, and babysitting pushes update it.
 */
export function assertSafeHeadRef(head: string, base: string): void {
  if (!safeHead.test(head)) {
    throw new Error(
      `refusing to push: head branch must be a sailor issue/thread branch (got "${head}")`,
    );
  }
  if (head === base) {
    throw new Error(`refusing to push: head equals base ("${base}")`);
  }
}

/**
 * Off-machine checkpoints (B) land on a side branch NEXT TO the head branch:
 * same issue scope, distinct name — the push webhook matches headRef exactly,
 * so checkpoint pushes are ignored (no acknowledgment-run storm).
 */
export function checkpointRefFor(headRef: string): string {
  return `${headRef}-checkpoint`;
}

export function assertSafeCheckpointRef(ref: string): void {
  if (!ref.endsWith("-checkpoint") || !safeHead.test(ref.slice(0, -"-checkpoint".length))) {
    throw new Error(
      `refusing to push: checkpoint branch must be a sailor issue/thread checkpoint (got "${ref}")`,
    );
  }
}
