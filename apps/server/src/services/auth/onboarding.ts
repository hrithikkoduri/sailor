/**
 * Onboarding rules: bind an installation to the signed-in user, sync its
 * repositories, and record which ones may trigger runs (the repo gate).
 */
import { and, asc, eq, inArray } from "drizzle-orm";
import { schema, type Db } from "../../db/index.js";
import type { GitHubAppService } from "../github/app.js";
import { syncRepositories, upsertInstallation } from "../github/installations.js";

export async function linkInstallation(
  db: Db,
  githubApp: GitHubAppService,
  userId: string,
  installationId: number,
) {
  const info = await githubApp.getInstallation(installationId);
  const row = await upsertInstallation(db, {
    installationId,
    accountLogin: info.account.login,
    accountType: info.account.type,
    userId,
  });
  const count = await syncRepositories(db, githubApp, row.id, installationId);
  return { accountLogin: info.account.login, repositories: count };
}

export async function onboardingState(db: Db, userId: string) {
  const installs = await db.select().from(schema.installations)
    .where(eq(schema.installations.userId, userId));
  const out = [];
  for (const inst of installs) {
    const repos = await db.select().from(schema.repositories)
      .where(eq(schema.repositories.installationRef, inst.id))
      .orderBy(asc(schema.repositories.fullName));
    out.push({
      installationId: inst.installationId,
      accountLogin: inst.accountLogin,
      suspended: inst.suspended,
      repos: repos.map((r) => ({
        fullName: r.fullName,
        enabled: r.enabled,
        defaultBranch: r.defaultBranch,
      })),
    });
  }
  return out;
}

export async function refreshRepositories(
  db: Db,
  githubApp: GitHubAppService,
  userId: string,
) {
  const installs = await db.select().from(schema.installations)
    .where(and(eq(schema.installations.userId, userId), eq(schema.installations.suspended, false)));
  let repositories = 0;
  for (const inst of installs)
    repositories += await syncRepositories(db, githubApp, inst.id, inst.installationId);
  return { repositories, installations: installs.length };
}

/** Only these repositories may trigger agent runs (decision #44). */
export async function setEnabledRepositories(
  db: Db,
  userId: string,
  installationId: number,
  enabled: string[],
) {
  const [inst] = await db.select().from(schema.installations)
    .where(and(
      eq(schema.installations.installationId, installationId),
      eq(schema.installations.userId, userId),
    ));
  if (!inst) return { error: "installation not found" as const };

  await db.update(schema.repositories)
    .set({ enabled: false, updatedAt: new Date() })
    .where(eq(schema.repositories.installationRef, inst.id));
  if (enabled.length > 0) {
    await db.update(schema.repositories)
      .set({ enabled: true, updatedAt: new Date() })
      .where(and(
        eq(schema.repositories.installationRef, inst.id),
        inArray(schema.repositories.fullName, enabled),
      ));
  }
  return { enabled: enabled.length };
}
