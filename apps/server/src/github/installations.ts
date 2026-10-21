/**
 * Installation bookkeeping — the DB side of the App model (decisions #42/#44).
 *
 * `repositories.enabled` is THE GATE: onboarding selections decide which repos
 * may trigger agent runs. Everything else (webhooks, sweeps) checks it first.
 */
import { and, eq, notInArray } from "drizzle-orm";
import { schema, type Db } from "../db/index.js";
import type { GitHubAppService } from "./app.js";

export interface InstallationSpec {
  installationId: number;
  accountLogin: string;
  accountType: string;
  /** Link only when currently unlinked (first linker wins). */
  userId?: string;
  suspended?: boolean;
}

export async function upsertInstallation(db: Db, spec: InstallationSpec) {
  const [existing] = await db
    .select()
    .from(schema.installations)
    .where(eq(schema.installations.installationId, spec.installationId));

  if (!existing) {
    const [created] = await db
      .insert(schema.installations)
      .values({
        installationId: spec.installationId,
        accountLogin: spec.accountLogin,
        accountType: spec.accountType,
        userId: spec.userId ?? null,
        suspended: spec.suspended ?? false,
      })
      .returning();
    return created!;
  }

  const [updated] = await db
    .update(schema.installations)
    .set({
      accountLogin: spec.accountLogin,
      accountType: spec.accountType,
      suspended: spec.suspended ?? existing.suspended,
      // First linker wins: never steal an existing link by a later installer.
      ...(existing.userId === null && spec.userId !== undefined ? { userId: spec.userId } : {}),
      updatedAt: new Date(),
    })
    .where(eq(schema.installations.id, existing.id))
    .returning();
  return updated!;
}

/** Refresh the repo list for an installation from GitHub (enabled flags kept). */
export async function syncRepositories(db: Db, githubApp: GitHubAppService, installationRowId: string, installationId: number) {
  const client = await githubApp.clientFor(installationId);
  const repos = await client.listInstallationRepositories();
  // Fetch every page before writing: an upstream error must never turn a
  // partial response into a deletion of still-accessible repositories.
  await db.transaction(async (tx) => {
    for (const repo of repos) {
      await tx
        .insert(schema.repositories)
        .values({
          installationRef: installationRowId,
          fullName: repo.full_name,
          defaultBranch: repo.default_branch,
        })
        .onConflictDoUpdate({
          target: [schema.repositories.installationRef, schema.repositories.fullName],
          set: { defaultBranch: repo.default_branch, updatedAt: new Date() },
        });
    }
    await tx.delete(schema.repositories).where(and(
      eq(schema.repositories.installationRef, installationRowId),
      ...(repos.length ? [notInArray(schema.repositories.fullName, repos.map((r) => r.full_name))] : []),
    ));
  });
  return repos.length;
}

/** THE GATE (decision #44): may this repo trigger agent runs? */
export async function repoEnabled(db: Db, installationId: number, fullName: string): Promise<boolean> {
  const [row] = await db
    .select({ enabled: schema.repositories.enabled })
    .from(schema.repositories)
    .innerJoin(schema.installations, eq(schema.repositories.installationRef, schema.installations.id))
    .where(and(eq(schema.installations.installationId, installationId), eq(schema.repositories.fullName, fullName)));
  return row?.enabled === true;
}
