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
  /**
   * The installation token itself — used as git credentials inside a sandbox.
   *
   * `repositories` narrows the token to those repository NAMES (GitHub's
   * installation-token scoping). Sailor always passes the one repository the
   * thread is allowed to touch: the token reaches the agent's shell, so an
   * unscoped installation token would grant every installed repository.
   */
  tokenFor(installationId: number, repositories?: readonly string[]): Promise<string>;
  /**
   * Drop cached tokens so the next mint reflects the CURRENT repository
   * toggles. Called at run start: a token carries the permissions it was
   * minted with for its whole life, so a toggle cannot affect a live one.
   */
  invalidateTokens(installationId?: number): void;
  /**
   * The App's own slug (GET /app) — the rename-proof bot identity. Webhook
   * self-checks (`<slug>[bot]`) read this instead of trusting a configured
   * string, which goes stale the moment the App is renamed.
   */
  appSlug(): Promise<string | undefined>;
  /**
   * The App's bot identity for commit attribution: `{ name, email }` with
   * GitHub's noreply email when the bot user resolves. Undefined when not.
   */
  botIdentity(): Promise<{ name: string; email: string } | undefined>;
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
  /** Tokens live about an hour; we never trust one older than this, so a
   * repo disabled in Settings stops being reachable within one run. */
  const TOKEN_MAX_AGE_MS = 10 * 60_000;
  const tokenCache = new Map<string, { token: string; expiresAt: number; mintedAt: number }>();
  // The App slug rarely changes (renames only) — cache it; a failed read
  // retries next call so a boot-time flake cannot freeze the fallback.
  let slugPromise: Promise<string | undefined> | undefined;
  let identityPromise:
    | Promise<{ name: string; email: string } | undefined>
    | undefined;

  async function appRequest<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await doFetch(`https://api.github.com${path}`, {
      method,
      headers: {
        authorization: `Bearer ${signAppJwt(opts.appId, opts.privateKey, now)}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "sailor-agent",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `github app ${method} ${path} failed: ${res.status} ${text.slice(0, 300).trim()}`,
      );
    }
    return (await res.json()) as T;
  }

  async function mint(installationId: number, repositories?: readonly string[]): Promise<string> {
    const res = await appRequest<{ token: string; expires_at: string }>(
      "POST",
      `/app/installations/${installationId}/access_tokens`,
      repositories?.length ? { repositories: [...repositories] } : undefined,
    );
    const scope = repositories?.length ? [...repositories].sort().join(",") : "*";
    tokenCache.set(`${installationId}:${scope}`, {
      token: res.token,
      expiresAt: new Date(res.expires_at).getTime(),
      mintedAt: now(),
    });
    return res.token;
  }

  async function tokenFor(
    installationId: number,
    repositories?: readonly string[],
  ): Promise<string> {
    // Scope is part of the cache key: a narrowed token must never be served
    // for an unscoped request, or vice versa.
    const scope = repositories?.length ? [...repositories].sort().join(",") : "*";
    const key = `${installationId}:${scope}`;
    const cached = tokenCache.get(key);
    if (
      cached &&
      now() - cached.mintedAt < TOKEN_MAX_AGE_MS &&
      cached.expiresAt - now() > 60_000
    )
      return cached.token;
    return mint(installationId, repositories);
  }

  // Rename-proof bot identity: webhooks present us as `<slug>[bot]` — never
  // trust a configured string for a self-check. Named (not inline) so
  // botIdentity can compose with it.
  const appSlug = (): Promise<string | undefined> => {
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
  };

  return {
    getInstallation: (installationId) =>
      appRequest("GET", `/app/installations/${installationId}`),
    tokenFor,
    invalidateTokens: (installationId) => {
      if (installationId === undefined) return tokenCache.clear();
      const prefix = `${installationId}:`;
      for (const key of tokenCache.keys())
        if (key.startsWith(prefix)) tokenCache.delete(key);
    },
    clientFor: async (installationId) =>
      createGitHubClient({ token: await tokenFor(installationId) }),
    appSlug,
    // Commit attribution: `<slug>[bot]` with GitHub's noreply email when the
    // bot user's id resolves (`<id>+<slug>[bot]@users.noreply.github.com`);
    // the plain login form is the fallback.
    botIdentity: () => {
      identityPromise ??= (async () => {
        const slug = await appSlug();
        if (!slug) return undefined;
        const login = `${slug}[bot]`;
        const info = await appRequest<{ id?: number }>(
          "GET",
          `/users/${encodeURIComponent(login)}`,
        ).catch(() => undefined);
        const id = typeof info?.id === "number" ? info.id : undefined;
        return {
          name: login,
          email: id
            ? `${id}+${login}@users.noreply.github.com`
            : `${login}@users.noreply.github.com`,
        };
      })().then((identity) => {
        if (!identity) identityPromise = undefined; // retry next call
        return identity;
      });
      return identityPromise;
    },
  };
}
