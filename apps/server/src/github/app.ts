/**
 * GitHubAppService — the App's identity for API calls (decision #42).
 *
 * Two jobs:
 *   1. sign app JWTs (RS256 with the private key) — the App's own credential
 *   2. mint + cache installation access tokens (~1h) and hand out a
 *      GitHubClient per installation (and the raw token, for sandbox git
 *      credentials)
 *
 * The private key is a DEPLOYMENT secret (env / platform store) — it never
 * touches the database and is never per-user.
 */
import { createSign } from "node:crypto";
import { createGitHubClient, type GitHubClient } from "./client.js";

export interface GitHubAppService {
  /** The App's JWT-signed view of an installation (account info, etc.). */
  getInstallation(
    installationId: number,
  ): Promise<{ id: number; account: { login: string; type: string } }>;
  /** Installation-scoped client — token minted, cached, refreshed. */
  clientFor(installationId: number): Promise<GitHubClient>;
  /** The installation token itself — used as git credentials inside a sandbox. */
  tokenFor(installationId: number): Promise<string>;
  /**
   * The App's own slug (GET /app) — the rename-proof bot identity. Webhook
   * self-checks (`<slug>[bot]`) read this instead of trusting a configured
   * string, which goes stale the moment the App is renamed.
   */
  appSlug(): Promise<string | undefined>;
}

export interface GitHubAppOptions {
  appId: string;
  /** PEM (raw or already \n-normalized). */
  privateKey: string;
  /** Test seams. */
  fetchFn?: typeof fetch;
  now?: () => number;
}

const b64url = (input: string | Buffer): string =>
  Buffer.from(input).toString("base64url");

/** A short-lived RS256 JWT — GitHub caps App JWTs at 10 minutes. */
export function signAppJwt(
  appId: string,
  privateKey: string,
  now: () => number,
): string {
  const iat = Math.floor(now() / 1000) - 60; // clock-skew allowance
  const exp = Math.floor(now() / 1000) + 540; // 9 minutes
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ iat, exp, iss: appId }));
  const signature = createSign("RSA-SHA256")
    .update(`${header}.${payload}`)
    .sign(privateKey);
  return `${header}.${payload}.${b64url(signature)}`;
}

export function createGitHubApp(opts: GitHubAppOptions): GitHubAppService {
  const doFetch = opts.fetchFn ?? fetch;
  const now = opts.now ?? (() => Date.now());
  const tokenCache = new Map<number, { token: string; expiresAt: number }>();
  // The App slug rarely changes (renames only) — cache it; a failed read
  // retries next call so a boot-time flake cannot freeze the fallback.
  let slugPromise: Promise<string | undefined> | undefined;

  async function appRequest<T>(method: string, path: string): Promise<T> {
    const res = await doFetch(`https://api.github.com${path}`, {
      method,
      headers: {
        authorization: `Bearer ${signAppJwt(opts.appId, opts.privateKey, now)}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "sailor-agent",
      },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `github app ${method} ${path} failed: ${res.status} ${text.slice(0, 300).trim()}`,
      );
    }
    return (await res.json()) as T;
  }

  async function mint(installationId: number): Promise<string> {
    const res = await appRequest<{ token: string; expires_at: string }>(
      "POST",
      `/app/installations/${installationId}/access_tokens`,
    );
    tokenCache.set(installationId, {
      token: res.token,
      expiresAt: new Date(res.expires_at).getTime(),
    });
    return res.token;
  }

  async function tokenFor(installationId: number): Promise<string> {
    const cached = tokenCache.get(installationId);
    if (cached && cached.expiresAt - now() > 5 * 60_000) return cached.token; // refresh window
    return mint(installationId);
  }

  return {
    getInstallation: (installationId) =>
      appRequest("GET", `/app/installations/${installationId}`),
    tokenFor,
    clientFor: async (installationId) =>
      createGitHubClient({ token: await tokenFor(installationId) }),
    // Rename-proof bot identity: webhooks present us as `<slug>[bot]` — never
    // trust a configured string for a self-check.
    appSlug: () => {
      slugPromise ??= appRequest<{ slug?: string }>("GET", "/app")
        .then((info) => {
          const slug =
            typeof info.slug === "string" && info.slug ? info.slug : undefined;
          if (!slug) slugPromise = undefined;
          return slug;
        })
        .catch(() => {
          slugPromise = undefined;
          return undefined;
        });
      return slugPromise;
    },
  };
}
