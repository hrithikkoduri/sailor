/**
 * Repo + ref helpers — pure, testable, boring on purpose.
 *
 * Threads store `repo` as a GitHub slug ("owner/name") or, in local dev, a
 * path; the `source` column is what disambiguates. The push guard here is
 * load-bearing: we only ever push `harness/*` branches and never the base.
 */

/** "owner/name" shape — format only; `threads.source` decides GitHub-ness. */
export function isGithubSlug(repo: string): boolean {
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) && !repo.includes("://");
}

export function githubRepoUrl(slug: string): string {
  return `https://github.com/${slug}.git`;
}

/** The one branch shape we push: harness/issue-<n>. */
export function headRefFor(issueNumber: number): string {
  return `harness/issue-${issueNumber}`;
}

/** Never push to main — or anywhere that isn't a harness/* branch. */
export function assertSafeHeadRef(head: string, base: string): void {
  if (!head.startsWith("harness/")) {
    throw new Error(`refusing to push: head branch must be "harness/*" (got "${head}")`);
  }
  if (head === base) {
    throw new Error(`refusing to push: head equals base ("${base}")`);
  }
}
