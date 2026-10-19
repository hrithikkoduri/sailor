/**
 * Sailor's SandboxStore — where sandbox continuity lives between runs.
 *
 * The package owns the session policy (adopt → clear the stale pointer →
 * fresh sources in order); this is the product's persistence for it: the
 * thread row's sandbox columns, keyed by thread id. One implementation, and
 * the package never learns about Postgres.
 */
import { eq } from "drizzle-orm";
import type { SandboxStore } from "anchor-ai-sdk";
import { schema, type Db } from "../db/index.js";

export function postgresSandboxStore(
  db: Db,
  /** Backend name for legacy rows that predate the backend column. */
  providerName: string,
): SandboxStore {
  return {
    get: async (key) => {
      const [row] = await db
        .select({
          sandboxId: schema.threads.sandboxId,
          sandboxBackend: schema.threads.sandboxBackend,
        })
        .from(schema.threads)
        .where(eq(schema.threads.id, key));
      if (!row?.sandboxId) return null;
      return {
        retained: {
          id: row.sandboxId,
          backend: row.sandboxBackend ?? providerName,
        },
      };
    },
    set: async (key, session) => {
      if (!session.retained) return;
      await db
        .update(schema.threads)
        .set({
          sandboxId: session.retained.id,
          sandboxBackend: session.retained.backend,
          updatedAt: new Date(),
        })
        .where(eq(schema.threads.id, key));
    },
    clear: async (key) => {
      await db
        .update(schema.threads)
        .set({ sandboxId: null, sandboxBackend: null, updatedAt: new Date() })
        .where(eq(schema.threads.id, key));
    },
  };
}
