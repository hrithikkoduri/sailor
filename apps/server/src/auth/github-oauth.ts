/**
 * "Sign in with GitHub" — user-to-server OAuth on the SAME GitHub App
 * (decision #41). Only the login leg: exchange the code, fetch the profile.
 * The user token is used once and NEVER persisted.
 */
export interface GithubIdentity {
  id: number;
  login: string;
  name: string | null;
  avatar_url: string | null;
  email: string | null;
}

export async function exchangeCodeForToken(opts: {
  clientId: string;
  clientSecret: string;
  code: string;
  fetchFn?: typeof fetch;
}): Promise<string> {
  const doFetch = opts.fetchFn ?? fetch;
  const res = await doFetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ client_id: opts.clientId, client_secret: opts.clientSecret, code: opts.code }),
  });
  if (!res.ok) throw new Error(`github oauth exchange failed: ${res.status}`);
  const data = (await res.json()) as { access_token?: string; error?: string; error_description?: string };
  if (!data.access_token) {
    throw new Error(`github oauth exchange failed: ${data.error_description ?? data.error ?? "no access_token"}`);
  }
  return data.access_token;
}

export async function fetchGithubIdentity(token: string, fetchFn?: typeof fetch): Promise<GithubIdentity> {
  const doFetch = fetchFn ?? fetch;
  const res = await doFetch("https://api.github.com/user", {
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "user-agent": "sailor-agent",
    },
  });
  if (!res.ok) throw new Error(`github user fetch failed: ${res.status}`);
  return (await res.json()) as GithubIdentity;
}
