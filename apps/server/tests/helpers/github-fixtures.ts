/**
 * Webhook-test fixtures: the repo gate (decision #44) requires an installation
 * + an ENABLED repository row before any event is processed. This seeds both.
 */
import { schema, type Db } from "../../src/db/index.js";

let seq = 0;

export interface SeededRepo {
  installationId: number;
  installationRowId: string;
}

/** Seed an installation + one repository (enabled by default). */
export async function seedRepo(
  db: Db,
  fullName: string,
  opts: { enabled?: boolean } = {},
): Promise<SeededRepo> {
  const installationId = Math.floor(Math.random() * 2 ** 31);
  const [installation] = await db
    .insert(schema.installations)
    .values({ installationId, accountLogin: `test-account-${++seq}`, accountType: "User" })
    .returning();
  await db.insert(schema.repositories).values({
    installationRef: installation!.id,
    fullName,
    enabled: opts.enabled ?? true,
  });
  return { installationId, installationRowId: installation!.id };
}
