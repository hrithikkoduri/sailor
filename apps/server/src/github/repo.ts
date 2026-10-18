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

/**
 * Never push to main — or anywhere that isn't one of OUR issue branches.
 * `sailor/*` is the current shape; `harness/*` is accepted because PRs opened
 * before the rename keep their branch, and babysitting pushes update it.
 */
export function assertSafeHeadRef(head: string, base: string): void {
  if (!/^(sailor|harness)\/issue-\d+$/.test(head)) {
    throw new Error(
      `refusing to push: head branch must be "sailor/issue-*" (got "${head}")`,
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
  if (!/^(sailor|harness)\/issue-\d+-checkpoint$/.test(ref)) {
    throw new Error(
      `refusing to push: checkpoint branch must be "sailor/issue-*-checkpoint" (got "${ref}")`,
    );
  }
}
