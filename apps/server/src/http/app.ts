/**
 * The webhook door — GitHub events in, threads and turns out.
 *
 * Order of defenses, on purpose:
 *   1. HMAC-verify the RAW body (nothing is parsed before this check)
 *   2. delivery-GUID ledger — GitHub delivers at-least-once; the ledger makes
 *      retries exactly-once
 *   3. handler routing (step 13 complete): issues:labeled opens threads;
 *      check_run/status → queue (machine, decision #28); reviews and human
 *      comments → interject (cancel the busy run; the feedback becomes the
 *      next turn); our own pushes → queue + acknowledge; pull_request closed
 *      → terminal thread state.
 *
 * The server only writes Postgres + the queue — the worker executes runs.
 */
import path from "node:path";
import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { serveStatic } from "@hono/node-server/serve-static";
import {
  createAuthRoutes,
  type AuthConfig,
  type UserFromRequest,
} from "./routes/auth.js";
import { createOnboardingRoutes } from "./routes/onboarding.js";
import { createApiRoutes } from "./api.js";
import { createStreamHub, type StreamHub } from "./stream.js";
import { sessionUser, SESSION_COOKIE } from "../services/auth/session.js";
import { ensureDevUser } from "../services/auth/users.js";
import { createLimiter, type Limiter } from "./rate-limit.js";
import { createWebhookRoutes } from "./routes/webhooks.js";
import type { ServerDeps } from "./server-deps.js";

export type { ServerDeps } from "./server-deps.js";
export { renderIssueTask } from "../services/github/webhook.js";

export function createServerApp(deps: ServerDeps): Hono {
  const app = new Hono();
  const log = deps.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  const authConfig: AuthConfig = deps.authConfig ?? {
    sessionTtlDays: 30,
    secureCookies: false,
    devBypass: false,
  };
  const publicUrl = deps.publicUrl ?? "http://localhost:5173";

  // Credential-stuffing guards: a burst of logins or signups from one address
  // is refused, which also caps how much argon2 work an attacker can trigger.
  const authLimiters = {
    login: deps.authLimiters?.login ?? createLimiter({ limit: 10, windowMs: 5 * 60_000 }),
    signup: deps.authLimiters?.signup ?? createLimiter({ limit: 5, windowMs: 60 * 60_000 }),
  };

  // The session resolver: cookie → session → user (or the dev-bypass user).
  const getUser: UserFromRequest = async (c) => {
    const user = await sessionUser(deps.db, getCookie(c, SESSION_COOKIE));
    if (user) return user;
    if (authConfig.devBypass) return ensureDevUser(deps.db);
    return undefined;
  };

  app.route(
    "/",
    createAuthRoutes({
      db: deps.db,
      config: authConfig,
      publicUrl,
      getUser,
      oauth: deps.oauth,
      loginLimiter: authLimiters.login,
      signupLimiter: authLimiters.signup,
      log,
    }),
  );
  app.route(
    "/",
    createOnboardingRoutes({
      db: deps.db,
      githubApp: deps.githubApp,
      publicUrl,
      getUser,
      log,
    }),
  );

  // The dashboard surface (step 17b): REST + SSE behind the same session auth.
  const hub = deps.hub ?? createStreamHub();
  deps.hub = hub;
  app.route(
    "/",
    createApiRoutes({ db: deps.db, queues: deps.queues, getUser, hub, log }),
  );

  app.get("/healthz", (c) => c.json({ ok: true, service: "sailor" }));

  // Readiness is dependency-aware: the process being up says nothing about
  // Postgres or Redis. Orchestrators gate traffic on this, not /healthz.
  app.get("/readyz", async (c) => {
    const result = deps.readyz ? await deps.readyz() : { ok: true, checks: {} };
    return c.json(result, result.ok ? 200 : 503);
  });

  app.route("/", createWebhookRoutes({ ...deps, log }));

  // The same origin serves the built dashboard. Backend prefixes always win;
  // everything else tries a real file, then falls back to index.html so the
  // SPA's client-side routes survive a refresh.
  if (deps.dashboardDir) {
    const root = deps.dashboardDir;
    const isBackend = (p: string) =>
      p === "/api" || p.startsWith("/api/") ||
      p === "/auth" || p.startsWith("/auth/") ||
      p === "/webhooks" || p.startsWith("/webhooks/") ||
      p === "/setup" || p.startsWith("/setup/") ||
      p === "/healthz" || p === "/readyz";
    app.use("*", async (c, next) =>
      isBackend(c.req.path) ? next() : serveStatic({ root })(c, next));
    app.get("*", async (c, next) =>
      isBackend(c.req.path) ? next() : serveStatic({ path: path.join(root, "index.html") })(c, next));
  }

  return app;
}
