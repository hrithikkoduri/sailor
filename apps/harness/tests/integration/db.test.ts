/**
 * Integration tests — need the real stack running: `docker compose up -d`.
 * Run with: npm run test:integration
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Pool } from "pg";
import { createDb, createPool, schema, type Db } from "../../src/db/index.js";
import { runMigrations } from "../../src/db/migrate.js";
import { loadConfig } from "../../src/config.js";

describe("database", () => {
  let pool: Pool;
  let db: Db;

  beforeAll(() => {
    pool = createPool(loadConfig().postgres.url);
    db = createDb(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  it("applies migrations idempotently", async () => {
    await runMigrations(db); // fresh DB: creates all tables
    await runMigrations(db); // re-run: no-op, must not throw
  });

  it("round-trips a thread with its budget defaults", async () => {
    const repo = `test/repo-${Date.now()}`; // unique, so tests never collide
    const [row] = await db.insert(schema.threads).values({ repo, issueNumber: 42 }).returning();
    expect(row!.state).toBe("queued");
    expect(row!.budgetMaxTurns).toBe(20);

    const [fetched] = await db.select().from(schema.threads).where(eq(schema.threads.id, row!.id));
    expect(fetched!.repo).toBe(repo);

    await db.delete(schema.threads).where(eq(schema.threads.id, row!.id));
  });

  it("enforces one thread per (repo, issue) — the business dedup key", async () => {
    const repo = `test/dup-${Date.now()}`;
    try {
      await db.insert(schema.threads).values({ repo, issueNumber: 7 });
      let error: unknown;
      try {
        await db.insert(schema.threads).values({ repo, issueNumber: 7 });
      } catch (err) {
        error = err;
      }
      // Drizzle wraps the driver error; the "duplicate key" text is in the cause chain.
      const messages: string[] = [];
      for (let e: unknown = error; e instanceof Error; e = e.cause ?? undefined) {
        messages.push(e.message);
      }
      expect(messages.join("\n")).toMatch(/duplicate key/i);
    } finally {
      await db.delete(schema.threads).where(eq(schema.threads.repo, repo));
    }
  });

  it("cascades deletes: run + trace_events die with their thread", async () => {
    const repo = `test/cascade-${Date.now()}`;
    const [thread] = await db.insert(schema.threads).values({ repo, issueNumber: 1 }).returning();
    const [run] = await db
      .insert(schema.runs)
      .values({ threadId: thread!.id, trigger: "manual" })
      .returning();
    await db.insert(schema.traceEvents).values({ runId: run!.id, seq: 0, type: "llm_call", payload: {} });

    await db.delete(schema.threads).where(eq(schema.threads.id, thread!.id));

    const orphans = await db.select().from(schema.traceEvents).where(eq(schema.traceEvents.runId, run!.id));
    expect(orphans).toEqual([]); // trace event died with the run, run died with the thread
  });
});
