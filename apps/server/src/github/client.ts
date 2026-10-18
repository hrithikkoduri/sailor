/**
 * GitHub REST client — the thin PAT wrapper the product needs, nothing more.
 *
 * Scoped deliberately: fetch an issue, open a PR, identify ourselves. Reviews,
 * comments, and checks arrive via webhooks (the event door); repos are cloned
 * and pushed by the sandbox layer (which already sets up git credentials), so
 * this client never touches git.
 *
 * `fetchFn` is injectable so the whole surface is unit-testable without
 * network — every module that uses it takes the client, not the token.
 */
export interface GithubIssue {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  state: string;
}

export interface GithubPullRequest {
  number: number;
  html_url: string;
}

export interface GithubPullRequestState {
  number: number;
  state: string; // open | closed
  merged: boolean;
  mergeable: boolean | null;
  mergeable_state?: string;
  html_url: string;
  head: { ref: string; sha: string };
}

export interface GithubCheckRun {
  name: string;
  status: string;
  conclusion: string | null;
}

export interface GithubComment {
  body: string | null;
  created_at: string;
  user?: { login?: string; type?: string };
}

export interface GithubUserProfile {
  id: number;
  login: string;
  type: string;
  name?: string | null;
  avatar_url?: string | null;
  email?: string | null;
}

export interface GithubInstallationRepo {
  full_name: string;
  private: boolean;
  default_branch: string;
}

export interface GitHubClient {
  getIssue(repo: string, issueNumber: number): Promise<GithubIssue>;
  createPullRequest(input: {
    repo: string;
    head: string;
    base: string;
    title: string;
    body: string;
    draft?: boolean;
  }): Promise<GithubPullRequest>;
  /** The PR's live state — used by the babysitter (checks, conflicts, merge). */
  getPullRequest(repo: string, prNumber: number): Promise<GithubPullRequestState>;
  /** Check runs for a commit — the sweep's definition of "CI failed". */
  getCheckRuns(repo: string, ref: string): Promise<GithubCheckRun[]>;
  /** PR/issue conversation comments, newest first as GitHub returns them. */
  listIssueComments(repo: string, issueNumber: number): Promise<GithubComment[]>;
  /** Post a comment (the blocked → needs-input channel, decision #40). */
  commentOnIssue(repo: string, issueNumber: number, body: string): Promise<void>;
  addLabels(repo: string, issueNumber: number, labels: string[]): Promise<void>;
  /** The repos this installation can see — onboarding's picker. */
  listInstallationRepositories(): Promise<GithubInstallationRepo[]>;
  whoami(): Promise<GithubUserProfile>;
}

export interface GitHubClientOptions {
  token: string;
  /** Test seam — defaults to global fetch. */
  fetchFn?: typeof fetch;
  /** Defaults to the public API; override for GitHub Enterprise. */
  baseUrl?: string;
}

export function createGitHubClient(opts: GitHubClientOptions): GitHubClient {
  const doFetch = opts.fetchFn ?? fetch;
  const baseUrl = (opts.baseUrl ?? "https://api.github.com").replace(/\/+$/, "");

  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await doFetch(`${baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${opts.token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "sailor-agent",
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`github ${method} ${path} failed: ${res.status} ${text.slice(0, 300).trim()}`);
    }
    return (await res.json()) as T;
  }

  return {
    getIssue: (repo, issueNumber) => request("GET", `/repos/${repo}/issues/${issueNumber}`),
    createPullRequest: (input) =>
      request("POST", `/repos/${input.repo}/pulls`, {
        title: input.title,
        head: input.head,
        base: input.base,
        body: input.body,
        ...(input.draft !== undefined ? { draft: input.draft } : {}),
      }),
    getPullRequest: (repo, prNumber) => request("GET", `/repos/${repo}/pulls/${prNumber}`),
    getCheckRuns: async (repo, ref) => {
      const res = await request<{ check_runs: GithubCheckRun[] }>(
        "GET",
        `/repos/${repo}/commits/${ref}/check-runs?per_page=50`,
      );
      return res.check_runs;
    },
    listIssueComments: (repo, issueNumber) =>
      request("GET", `/repos/${repo}/issues/${issueNumber}/comments?per_page=50`),
    commentOnIssue: (repo, issueNumber, body) =>
      request("POST", `/repos/${repo}/issues/${issueNumber}/comments`, { body }),
    addLabels: (repo, issueNumber, labels) =>
      request("POST", `/repos/${repo}/issues/${issueNumber}/labels`, { labels }),
    listInstallationRepositories: async () => {
      const res = await request<{ repositories: GithubInstallationRepo[] }>(
        "GET",
        "/installation/repositories?per_page=100",
      );
      return res.repositories;
    },
    whoami: () => request("GET", "/user"),
  };
}
