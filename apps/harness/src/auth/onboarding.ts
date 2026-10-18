/**
 * Onboarding routes (decisions #43/#44): the GitHub install lands on /setup,
 * which links the installation to the logged-in user and syncs its repos;
 * the SPA then lets the user pick which repos may trigger agent runs.
 */
import { Hono } from "hono";
import { deleteCookie, getCookie } from "hono/cookie";
import { and, asc, eq, inArray } from "drizzle-orm";
import { schema, type Db } from "../db/index.js";
import type { GitHubAppService } from "../github/app.js";
import { syncRepositories, upsertInstallation } from "../github/installations.js";
import { publicUser } from "./users.js";
import { INSTALL_STATE_COOKIE, type UserFromRequest } from "./routes.js";

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
    if (state !== undefined && state !== cookieState) {
      return c.json({ error: "state mismatch — restart the install" }, 400);
    }
    deleteCookie(c, INSTALL_STATE_COOKIE, { path: "/" });
    if (!deps.githubApp) {
      return c.json({ error: "GitHub App not configured (GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY)" }, 500);
    }

    const info = await deps.githubApp.getInstallation(installationId);
    const row = await upsertInstallation(deps.db, {
      installationId,
      accountLogin: info.account.login,
      accountType: info.account.type,
      userId: user.id,
    });
    const count = await syncRepositories(deps.db, deps.githubApp, row.id, installationId);
    deps.log?.(
      `setup: installation ${installationId} (${info.account.login}) linked to ${user.email ?? user.id}; ${count} repos synced`,
    );
    return c.redirect(`${deps.publicUrl}/onboarding?installation=${installationId}`);
  });

  app.get("/api/onboarding", async (c) => {
    const user = await deps.getUser(c);
    if (!user) return c.json({ error: "unauthorized" }, 401);

    const installs = await deps.db
      .select()
      .from(schema.installations)
      .where(eq(schema.installations.userId, user.id));
    const out = [];
    for (const inst of installs) {
      const repos = await deps.db
        .select()
        .from(schema.repositories)
        .where(eq(schema.repositories.installationRef, inst.id))
        .orderBy(asc(schema.repositories.fullName));
      out.push({
        installationId: inst.installationId,
        accountLogin: inst.accountLogin,
        suspended: inst.suspended,
        repos: repos.map((r) => ({ fullName: r.fullName, enabled: r.enabled, defaultBranch: r.defaultBranch })),
      });
    }
    return c.json({
      user: publicUser(user),
      githubAppConfigured: deps.githubApp !== undefined,
      installations: out,
    });
  });

  // The repo gate's control surface (decision #44): only enabled repos trigger runs.
  app.post("/api/onboarding/repos", async (c) => {
    const user = await deps.getUser(c);
    if (!user) return c.json({ error: "unauthorized" }, 401);
    const body = (await c.req.json().catch(() => ({}))) as { installationId?: unknown; enabled?: unknown };
    const installationId = Number(body.installationId);
    const enabled = Array.isArray(body.enabled) ? body.enabled.filter((n): n is string => typeof n === "string") : [];
    if (!Number.isFinite(installationId)) return c.json({ error: "missing installationId" }, 400);

    const [inst] = await deps.db
      .select()
      .from(schema.installations)
      .where(and(eq(schema.installations.installationId, installationId), eq(schema.installations.userId, user.id)));
    if (!inst) return c.json({ error: "installation not found" }, 404);

    await deps.db
      .update(schema.repositories)
      .set({ enabled: false, updatedAt: new Date() })
      .where(eq(schema.repositories.installationRef, inst.id));
    if (enabled.length > 0) {
      await deps.db
        .update(schema.repositories)
        .set({ enabled: true, updatedAt: new Date() })
        .where(
          and(eq(schema.repositories.installationRef, inst.id), inArray(schema.repositories.fullName, enabled)),
        );
    }
    deps.log?.(`onboarding: ${enabled.length} repo(s) enabled for installation ${installationId}`);
    return c.json({ ok: true, enabled: enabled.length });
  });

  return app;
}
