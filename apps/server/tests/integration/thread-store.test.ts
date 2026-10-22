/**
 * PostgresThreadStore integration test — the durable ThreadStore roundtrip.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Pool } from "pg";
import { createDb, createPool, schema, type Db } from "../../src/db/index.js";
import { runMigrations } from "../../src/db/migrate.js";
import { PostgresThreadStore } from "../../src/services/threads/thread-store.js";
import { loadConfig } from "../../src/config.js";

describe("PostgresThreadStore", () => {
  let pool: Pool;
  let db: Db;
  let threadId: string;
  let store: PostgresThreadStore;

  beforeAll(async () => {
    pool = createPool(loadConfig().postgres.url);
    db = createDb(pool);
    await runMigrations(db);
    const [thread] = await db
      .insert(schema.threads)
      .values({ repo: `test/thread-store-${Date.now()}`, issueNumber: 1 })
      .returning();
    threadId = thread!.id;
    store = new PostgresThreadStore(db);
  });

  afterAll(async () => {
    await db.delete(schema.threads).where(eq(schema.threads.id, threadId));
    await pool.end();
  });

  it("round-trips summary, messages, and phase (overwrite semantics)", async () => {
    await store.save(threadId, {
      summary: "earlier work",
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
      ],
      phase: "fix",
    });

    const loaded = await store.load(threadId);
    expect(loaded!.summary).toBe("earlier work");
    expect(loaded!.phase).toBe("fix");
    expect(loaded!.messages).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ]);

    // Overwrite: a completed run clears the phase but keeps the memory.
    await store.save(threadId, { summary: "earlier work", messages: loaded!.messages });
    const updated = await store.load(threadId);
    expect(updated!.phase).toBeUndefined();
    expect(updated!.messages).toHaveLength(2);
  });

  it("returns undefined for a missing thread", async () => {
    const loaded = await store.load("00000000-0000-0000-0000-000000000000");
    expect(loaded).toBeUndefined();
  });
});
