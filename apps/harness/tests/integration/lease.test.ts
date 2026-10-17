/**
 * Run lease integration test — needs the stack (`docker compose up -d`).
 * Proves the crash detector: a stale heartbeat means the worker died; the
 * sweep interrupts the run and enqueues a resume for the same thread, while
 * fresh runs are untouched.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Pool } from "pg";
import { createDb, createPool, schema, type Db } from "../../src/db/index.js";
import { runMigrations } from "../../src/db/migrate.js";
import { heartbeatRun, sweepStaleRuns } from "../../src/runs/lease.js";
import { loadConfig } from "../../src/config.js";

describe("run leases", () => {
  let pool: Pool;
  let db: Db;
  let threadId: string;

  beforeAll(async () => {
    pool = createPool(loadConfig().postgres.url);
    db = createDb(pool);
    await runMigrations(db);
    const [thread] = await db
      .insert(schema.threads)
      .values({ repo: `test/lease-${Date.now()}`, issueNumber: 1 })
      .returning();
    threadId = thread!.id;
  });

  afterAll(async () => {
    await db.delete(schema.threads).where(eq(schema.threads.id, threadId));
    await pool.end();
  });

  it("marks stale runs interrupted and enqueues a resume run", async () => {
    // A dead worker: status running, heartbeat 10 minutes old.
    const [stale] = await db
      .insert(schema.runs)
      .values({
        threadId,
        trigger: "manual",
        status: "running",
        heartbeatAt: new Date(Date.now() - 10 * 60_000),
      })
      .returning();
    // A live worker: fresh heartbeat — must not be touched.
    const [fresh] = await db
      .insert(schema.runs)
      .values({ threadId, trigger: "manual", status: "running", heartbeatAt: new Date() })
      .returning();

    const results = await sweepStaleRuns(db);
    expect(results.map((r) => r.staleRunId)).toContain(stale!.id);
    expect(results.map((r) => r.staleRunId)).not.toContain(fresh!.id);

    const [interrupted] = await db.select().from(schema.runs).where(eq(schema.runs.id, stale!.id));
    expect(interrupted!.status).toBe("interrupted");

    const resume = results.find((r) => r.staleRunId === stale!.id)!;
    const [resumeRun] = await db.select().from(schema.runs).where(eq(schema.runs.id, resume.resumeRunId));
    expect(resumeRun!.status).toBe("queued");
    expect(resumeRun!.trigger).toBe("resume");
    expect(resumeRun!.threadId).toBe(threadId);

    const [stillFresh] = await db.select().from(schema.runs).where(eq(schema.runs.id, fresh!.id));
    expect(stillFresh!.status).toBe("running");
  });

  it("heartbeatRun stamps a running run", async () => {
    const [run] = await db
      .insert(schema.runs)
      .values({ threadId, trigger: "manual", status: "running" })
      .returning();
    await heartbeatRun(db, run!.id);
    const [stamped] = await db.select().from(schema.runs).where(eq(schema.runs.id, run!.id));
    expect(stamped!.heartbeatAt).not.toBeNull();
  });
});
