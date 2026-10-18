/**
 * Auth routes (decisions #41/#43): signup, login, logout, me, GitHub sign-in,
 * and the App install kick-off.
 */
import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { randomBytes } from "node:crypto";
import type { Db } from "../db/index.js";
import type { User } from "../db/schema.js";
import { createSession, deleteSession, SESSION_COOKIE } from "./session.js";
import { hashPassword, normalizeEmail, passwordProblem, verifyPassword } from "./password.js";
import { createEmailUser, findUserByEmail, publicUser, upsertGithubUser } from "./users.js";
import { exchangeCodeForToken, fetchGithubIdentity } from "./github-oauth.js";

export interface AuthConfig {
  sessionTtlDays: number;
  secureCookies: boolean;
  /** DEV ONLY (decision #43): skip auth; never honored in production. */
  devBypass: boolean;
}

export type UserFromRequest = (c: Context) => Promise<User | undefined>;

export const OAUTH_STATE_COOKIE = "harness_oauth_state";
export const INSTALL_STATE_COOKIE = "harness_install_state";

export interface AuthRoutesDeps {
  db: Db;
  config: AuthConfig;
  /** Dashboard base URL — where browser-facing redirects land. */
  publicUrl: string;
  getUser: UserFromRequest;
  oauth?: { slug?: string; clientId?: string; clientSecret?: string; fetchFn?: typeof fetch };
  log?: (line: string) => void;
}

export function createAuthRoutes(deps: AuthRoutesDeps): Hono {
  const app = new Hono();
  const cookieOpts = { httpOnly: true, secure: deps.config.secureCookies, sameSite: "Lax" as const, path: "/" };
  const setSession = (c: Context, token: string, expiresAt: Date) =>
    setCookie(c, SESSION_COOKIE, token, { ...cookieOpts, expires: expiresAt });

  app.post("/auth/signup", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { email?: unknown; password?: unknown };
    const email = normalizeEmail(body.email);
    const problem = passwordProblem(body.password);
    if (!email) return c.json({ error: "enter a valid email address" }, 400);
    if (problem) return c.json({ error: problem }, 400);
    if (await findUserByEmail(deps.db, email)) return c.json({ error: "that email is already registered" }, 409);

    const user = await createEmailUser(deps.db, email, await hashPassword(body.password as string));
    const session = await createSession(deps.db, user.id, deps.config.sessionTtlDays);
    setSession(c, session.token, session.expiresAt);
    deps.log?.(`auth: signup ${email}`);
    return c.json({ user: publicUser(user) }, 201);
  });

  app.post("/auth/login", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { email?: unknown; password?: unknown };
    const email = normalizeEmail(body.email);
    const user = email ? await findUserByEmail(deps.db, email) : undefined;
    // One error for unknown email / wrong password / GitHub-only account.
    if (!user?.passwordHash || !(await verifyPassword(user.passwordHash, String(body.password ?? "")))) {
      return c.json({ error: "invalid email or password" }, 401);
    }
    const session = await createSession(deps.db, user.id, deps.config.sessionTtlDays);
    setSession(c, session.token, session.expiresAt);
    deps.log?.(`auth: login ${email}`);
    return c.json({ user: publicUser(user) });
  });

  app.post("/auth/logout", async (c) => {
    const token = getCookie(c, SESSION_COOKIE);
    if (token) await deleteSession(deps.db, token);
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.json({ ok: true });
  });

  app.get("/auth/me", async (c) => {
    const user = await deps.getUser(c);
    if (!user) return c.json({ error: "unauthorized" }, 401);
    return c.json({ user: publicUser(user) });
  });

  app.get("/auth/github", (c) => {
    const clientId = deps.oauth?.clientId;
    if (!clientId) return c.json({ error: "GitHub sign-in is not configured (GITHUB_APP_CLIENT_ID)" }, 500);
    const state = randomBytes(16).toString("base64url");
    setCookie(c, OAUTH_STATE_COOKIE, state, { ...cookieOpts, maxAge: 600 });
    return c.redirect(
      `https://github.com/login/oauth/authorize?client_id=${encodeURIComponent(clientId)}&state=${state}`,
    );
  });

  app.get("/auth/github/callback", async (c) => {
    const oauth = deps.oauth;
    if (!oauth?.clientId || !oauth.clientSecret) return c.json({ error: "GitHub sign-in is not configured" }, 500);
    const code = c.req.query("code");
    const state = c.req.query("state");
    const cookieState = getCookie(c, OAUTH_STATE_COOKIE);
    if (!code) return c.json({ error: "missing code" }, 400);
    if (state !== undefined && state !== cookieState) {
      return c.json({ error: "state mismatch — restart sign-in" }, 400);
    }
    deleteCookie(c, OAUTH_STATE_COOKIE, { path: "/" });

    try {
      const token = await exchangeCodeForToken({
        clientId: oauth.clientId,
        clientSecret: oauth.clientSecret,
        code,
        fetchFn: oauth.fetchFn,
      });
      const identity = await fetchGithubIdentity(token, oauth.fetchFn);
      const user = await upsertGithubUser(deps.db, identity);
      const session = await createSession(deps.db, user.id, deps.config.sessionTtlDays);
      setSession(c, session.token, session.expiresAt);
      deps.log?.(`auth: github sign-in ${identity.login} (user ${user.id})`);
      return c.redirect(`${deps.publicUrl}/onboarding`);
    } catch (err) {
      deps.log?.(`auth: github callback failed — ${err instanceof Error ? err.message : String(err)}`);
      return c.json({ error: "GitHub sign-in failed — please try again" }, 502);
    }
  });

  app.get("/auth/install", async (c) => {
    const user = await deps.getUser(c);
    if (!user) return c.redirect(`${deps.publicUrl}/login`);
    const slug = deps.oauth?.slug;
    if (!slug) return c.json({ error: "GitHub App is not configured (GITHUB_APP_SLUG)" }, 500);
    const state = randomBytes(16).toString("base64url");
    setCookie(c, INSTALL_STATE_COOKIE, state, { ...cookieOpts, maxAge: 600 });
    return c.redirect(`https://github.com/apps/${slug}/installations/new?state=${state}`);
  });

  return app;
}
