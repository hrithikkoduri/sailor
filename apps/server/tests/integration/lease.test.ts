/**
 * Run lease integration test — needs the stack (`docker compose up -d`).
 * Proves the crash detector: a stale heartbeat means the worker died; the
 * sweep interrupts the run and enqueues a resume for the same thread, while
 * fresh runs are untouched.
 *
 * Note: each active run gets its OWN thread — the unique index enforces one
 * active run per thread (the one-turn-at-a-time rule), so two "running" runs
 * can never share a thread.
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
  const threadIds: string[] = [];

  const newThread = async (issue: number) => {
    const [thread] = await db
      .insert(schema.threads)
      .values({ repo: `test/lease-${Date.now()}-${issue}`, issueNumber: issue })
      .returning();
    threadIds.push(thread!.id);
    return thread!.id;
  };

  beforeAll(async () => {
    pool = createPool(loadConfig().postgres.url);
    db = createDb(pool);
    await runMigrations(db);
  });

  afterAll(async () => {
    for (const id of threadIds) await db.delete(schema.threads).where(eq(schema.threads.id, id));
    await pool.end();
  });

  it("marks stale runs interrupted and enqueues a resume run", async () => {
    const staleThread = await newThread(1);
    const freshThread = await newThread(2);

    // A dead worker: status running, heartbeat 10 minutes old.
    const [stale] = await db
      .insert(schema.runs)
      .values({
        threadId: staleThread,
        trigger: "manual",
        status: "running",
        heartbeatAt: new Date(Date.now() - 10 * 60_000),
      })
      .returning();
    // A live worker: fresh heartbeat — must not be touched.
    const [fresh] = await db
      .insert(schema.runs)
      .values({ threadId: freshThread, trigger: "manual", status: "running", heartbeatAt: new Date() })
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
    expect(resumeRun!.threadId).toBe(staleThread);

    const [stillFresh] = await db.select().from(schema.runs).where(eq(schema.runs.id, fresh!.id));
    expect(stillFresh!.status).toBe("running");
  });

  it("heartbeatRun stamps a running run", async () => {
    const threadId = await newThread(3);
    const [run] = await db
      .insert(schema.runs)
      .values({ threadId, trigger: "manual", status: "running" })
      .returning();
    await heartbeatRun(db, run!.id);
    const [stamped] = await db.select().from(schema.runs).where(eq(schema.runs.id, run!.id));
    expect(stamped!.heartbeatAt).not.toBeNull();
  });
});
