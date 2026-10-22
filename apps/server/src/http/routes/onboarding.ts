/**
 * Onboarding routes: the GitHub install hand-off, repository listing, refresh,
 * and the repo gate's control surface. Rules live in `services/auth/onboarding`.
 */
import { Hono } from "hono";
import { deleteCookie, getCookie } from "hono/cookie";
import type { Db } from "../../db/index.js";
import type { GitHubAppService } from "../../services/github/app.js";
import { publicUser } from "../../services/auth/users.js";
import {
  linkInstallation,
  onboardingState,
  refreshRepositories,
  setEnabledRepositories,
} from "../../services/auth/onboarding.js";
import { INSTALL_STATE_COOKIE, type UserFromRequest } from "./auth.js";

export interface OnboardingDeps {
  db: Db;
  githubApp?: GitHubAppService;
  publicUrl: string;
  getUser: UserFromRequest;
  log?: (line: string) => void;
}

export function createOnboardingRoutes(deps: OnboardingDeps): Hono {
  const app = new Hono();

  // GitHub redirects here after an install (the App's Setup URL). The `state`
  // param (set by /auth/install) binds the install to the logged-in user; the
  // `installation` webhook's sender is the fallback binder.
  app.get("/setup", async (c) => {
    const user = await deps.getUser(c);
    if (!user) return c.redirect(`${deps.publicUrl}/login`);
    const installationId = Number(c.req.query("installation_id"));
    if (!Number.isFinite(installationId)) return c.json({ error: "missing installation_id" }, 400);
    const state = c.req.query("state");
    const cookieState = getCookie(c, INSTALL_STATE_COOKIE);
    if (state !== undefined && state !== cookieState)
      return c.json({ error: "state mismatch — restart the install" }, 400);
    deleteCookie(c, INSTALL_STATE_COOKIE, { path: "/" });
    if (!deps.githubApp)
      return c.json({ error: "GitHub App not configured (GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY)" }, 500);

    const result = await linkInstallation(deps.db, deps.githubApp, user.id, installationId);
    deps.log?.(`setup: installation ${installationId} (${result.accountLogin}) linked to ${user.email ?? user.id}; ${result.repositories} repos synced`);
    return c.redirect(`${deps.publicUrl}/onboarding?installation=${installationId}`);
  });

  app.get("/api/onboarding", async (c) => {
    const user = await deps.getUser(c);
    if (!user) return c.json({ error: "unauthorized" }, 401);
    return c.json({
      user: publicUser(user),
      githubAppConfigured: deps.githubApp !== undefined,
      installations: await onboardingState(deps.db, user.id),
    });
  });

  app.post("/api/onboarding/repos/refresh", async (c) => {
    const user = await deps.getUser(c);
    if (!user) return c.json({ error: "unauthorized" }, 401);
    if (!deps.githubApp) return c.json({ error: "The GitHub App is not configured on this server." }, 503);
    try {
      const result = await refreshRepositories(deps.db, deps.githubApp, user.id);
      deps.log?.(`onboarding: refreshed ${result.repositories} repositories across ${result.installations} installation(s)`);
      return c.json({ ok: true, ...result });
    } catch {
      return c.json({ error: "GitHub couldn't refresh all repositories. Check your installation access and try again. Existing enabled choices have been preserved." }, 502);
    }
  });

  app.post("/api/onboarding/repos", async (c) => {
    const user = await deps.getUser(c);
    if (!user) return c.json({ error: "unauthorized" }, 401);
    const body = (await c.req.json().catch(() => ({}))) as { installationId?: unknown; enabled?: unknown };
    const installationId = Number(body.installationId);
    const enabled = Array.isArray(body.enabled)
      ? body.enabled.filter((n): n is string => typeof n === "string")
      : [];
    if (!Number.isFinite(installationId))
      return c.json({ error: "missing installationId" }, 400);

    const result = await setEnabledRepositories(deps.db, user.id, installationId, enabled);
    if ("error" in result) return c.json({ error: result.error }, 404);
    deps.log?.(`onboarding: ${result.enabled} repo(s) enabled for installation ${installationId}`);
    return c.json({ ok: true, enabled: result.enabled });
  });

  return app;
}
