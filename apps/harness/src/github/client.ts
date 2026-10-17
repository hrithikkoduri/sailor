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

export interface GitHubClient {
  getIssue(repo: string, issueNumber: number): Promise<GithubIssue>;
  createPullRequest(input: {
    repo: string;
    head: string;
    base: string;
    title: string;
    body: string;
  }): Promise<GithubPullRequest>;
  whoami(): Promise<{ login: string; type: string }>;
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
        "user-agent": "harness-agent",
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
      }),
    whoami: () => request("GET", "/user"),
  };
}
