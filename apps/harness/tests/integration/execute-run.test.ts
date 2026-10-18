/**
 * executeRun integration test — a full DB-backed run with a scripted LLM and
 * a real local sandbox: status transitions, usage, thread persistence, trace
 * rows, and the checkpoint pointer all recorded.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
import { createDb, createPool, schema, type Db } from "../../src/db/index.js";
import { runMigrations } from "../../src/db/migrate.js";
import { executeRun } from "../../src/runs/execute.js";
import { PostgresThreadStore } from "../../src/threads/thread-store.js";
import { loadConfig } from "../../src/config.js";
import { FIX_FIXTURE_SCRIPT, scriptedLLM } from "../helpers/scripted-llm.js";

const FIXTURE = fileURLToPath(new URL("../../../../fixtures/buggy-lib", import.meta.url));

describe("executeRun", () => {
  let pool: Pool;
  let db: Db;
  let threadId: string;
  let runId: string;

  beforeAll(async () => {
    pool = createPool(loadConfig().postgres.url);
    db = createDb(pool);
    await runMigrations(db);
    const [thread] = await db
      .insert(schema.threads)
      .values({ repo: FIXTURE, issueNumber: 1 })
      .returning();
    threadId = thread!.id;
    const [run] = await db
      .insert(schema.runs)
      .values({ threadId, trigger: "manual", task: "add() ignores negative numbers" })
      .returning();
    runId = run!.id;
  });

  afterAll(async () => {
    await db.delete(schema.threads).where(eq(schema.threads.id, threadId));
    await pool.end();
  });

  it("executes a run end-to-end and records everything", async () => {
    const outcome = await executeRun({ db, runId, local: true, llm: scriptedLLM(FIX_FIXTURE_SCRIPT) });

    expect(outcome.status).toBe("succeeded");
    expect(outcome.summary).toContain("fixed negatives");

    const [run] = await db.select().from(schema.runs).where(eq(schema.runs.id, runId));
    expect(run!.status).toBe("succeeded");
    expect(run!.steps).toBe(6);
    expect(run!.tokensIn).toBe(600);
    expect(run!.tokensOut).toBe(60);
    expect(run!.phase).toBe("verify");
    expect(run!.startedAt).not.toBeNull();
    expect(run!.finishedAt).not.toBeNull();
    expect(run!.finishedAt!.getTime()).toBeGreaterThanOrEqual(run!.startedAt!.getTime());

    // The thread now carries the conversation; a completed run clears the
    // resume position but the thread's checkpoint pointer is set.
    const store = new PostgresThreadStore(db);
    const thread = await store.load(threadId);
    expect(thread!.messages.length).toBeGreaterThanOrEqual(4);
    expect(thread!.phase).toBeUndefined();
    const [threadRow] = await db.select().from(schema.threads).where(eq(schema.threads.id, threadId));
    expect(threadRow!.checkpointSha).toMatch(/^[0-9a-f]{40}$/);

    // Traces landed in the DB (the journal).
    const traceRows = await db.select().from(schema.traceEvents).where(eq(schema.traceEvents.runId, runId));
    expect(traceRows.length).toBeGreaterThanOrEqual(10);
    expect(traceRows.map((r) => r.seq)).toEqual([...traceRows.map((r) => r.seq)].sort((a, b) => a - b));
  }, 120_000);
});
