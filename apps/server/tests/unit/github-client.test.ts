/**
 * GitHub client — request shapes verified against a mocked fetch. No network.
 */
import { describe, expect, it, vi } from "vitest";
import { createGitHubClient } from "../../src/github/client.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const asFetch = (fn: unknown) => fn as typeof fetch;

describe("github client", () => {
  it("getIssue hits the REST path with auth + version headers", async () => {
    const fetchFn = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({ number: 7, title: "bug", body: null, html_url: "https://x", state: "open" }),
    );
    const client = createGitHubClient({ token: "tok", fetchFn: asFetch(fetchFn) });

    const issue = await client.getIssue("acme/demo", 7);
    expect(issue.title).toBe("bug");

    const [url, init] = fetchFn.mock.calls[0]!;
    expect(String(url)).toBe("https://api.github.com/repos/acme/demo/issues/7");
    const headers = init!.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer tok");
    expect(headers.accept).toBe("application/vnd.github+json");
    expect(headers["x-github-api-version"]).toBe("2022-11-28");
  });

  it("createPullRequest posts the exact PR fields", async () => {
    const fetchFn = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({ number: 42, html_url: "https://github.com/acme/demo/pull/42" }),
    );
    const client = createGitHubClient({ token: "t", fetchFn: asFetch(fetchFn) });

    const pr = await client.createPullRequest({
      repo: "acme/demo",
      head: "sailor/issue-7",
      base: "main",
      title: "Fix #7: bug",
      body: "the body",
    });
    expect(pr.number).toBe(42);

    const [url, init] = fetchFn.mock.calls[0]!;
    expect(String(url)).toBe("https://api.github.com/repos/acme/demo/pulls");
    expect(init!.method).toBe("POST");
    expect(JSON.parse(String(init!.body))).toEqual({
      title: "Fix #7: bug",
      head: "sailor/issue-7",
      base: "main",
      body: "the body",
    });
  });

  it("throws a readable error on non-2xx responses", async () => {
    const fetchFn = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      new Response('{"message":"Not Found"}', { status: 404 }),
    );
    const client = createGitHubClient({ token: "t", fetchFn: asFetch(fetchFn) });
    await expect(client.getIssue("acme/missing", 1)).rejects.toThrow(/github GET .* 404/);
  });

  it("whoami identifies the token owner", async () => {
    const fetchFn = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({ login: "sailor-bot", type: "Bot" }),
    );
    const client = createGitHubClient({ token: "t", fetchFn: asFetch(fetchFn) });
    expect(await client.whoami()).toEqual({ login: "sailor-bot", type: "Bot" });
  });
});
