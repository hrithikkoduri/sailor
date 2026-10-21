import { and, eq } from "drizzle-orm";
import { schema, type Db } from "../db/index.js";

/** Authorization boundary shared by the composer, answers, and agent tools. */
export async function enabledRepositories(db: Db, userId: string | null) {
  if (!userId) return [];
  return db.select({
    fullName: schema.repositories.fullName,
    defaultBranch: schema.repositories.defaultBranch,
    installationId: schema.installations.installationId,
  }).from(schema.repositories)
    .innerJoin(schema.installations, eq(schema.repositories.installationRef, schema.installations.id))
    .where(and(eq(schema.installations.userId, userId), eq(schema.installations.suspended, false), eq(schema.repositories.enabled, true)));
}
