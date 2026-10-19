/**
 * Trace persistence integration test — needs the stack (`docker compose up -d`).
 * Proves the journal property: events land in trace_events in engine order,
 * with full payloads (the material durable resume will replay).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
import type { Pool } from "pg";
import type { AgentEvent } from "anchor-ai-sdk";
import { TraceFanout } from "anchor-ai-sdk";
import { createDb, createPool, schema, type Db } from "../../src/db/index.js";
import { runMigrations } from "../../src/db/migrate.js";
import { TraceRecorder } from "../../src/trace/store.js";
import { loadConfig } from "../../src/config.js";

describe("trace persistence (db)", () => {
  let pool: Pool;
  let db: Db;
  let runId: string;
  let threadId: string;

  beforeAll(async () => {
    pool = createPool(loadConfig().postgres.url);
    db = createDb(pool);
    await runMigrations(db);

    const [thread] = await db
      .insert(schema.threads)
      .values({ repo: `test/trace-${Date.now()}`, issueNumber: 1 })
      .returning();
    threadId = thread!.id;
    const [run] = await db
      .insert(schema.runs)
      .values({ threadId, trigger: "manual" })
      .returning();
    runId = run!.id;
  });

  afterAll(async () => {
    await db.delete(schema.threads).where(eq(schema.threads.id, threadId));
    await pool.end();
  });

  it("persists events in order with full payloads", async () => {
    const recorder = new TraceRecorder({ db, runId });
    const fanout = new TraceFanout([recorder]);
    const events: AgentEvent[] = [
      {
        type: "run_started",
        task: "fix the bug",
        phases: ["reproduce", "fix", "verify"],
      },
      { type: "phase_started", phase: "reproduce" },
      {
        type: "tool_call",
        phase: "reproduce",
        step: 1,
        name: "run_tests",
        input: {},
      },
      {
        type: "tool_result",
        phase: "reproduce",
        step: 1,
        name: "run_tests",
        ok: false,
        content: "AssertionError: 0 !== -3",
        contentChars: 22,
        meta: { ran: true, exitCode: 1 },
      },
    ];
    for (const e of events) fanout.record(e);
    await fanout.flush();
    expect(recorder.events).toBe(4);

    const rows = await db
      .select()
      .from(schema.traceEvents)
      .where(eq(schema.traceEvents.runId, runId))
      .orderBy(asc(schema.traceEvents.seq));

    expect(rows.map((r) => r.type)).toEqual([
      "run_started",
      "phase_started",
      "tool_call",
      "tool_result",
    ]);
    expect(rows.map((r) => r.seq)).toEqual([0, 1, 2, 3]);
    const toolResult = rows[3]!.payload as Extract<
      AgentEvent,
      { type: "tool_result" }
    >;
    expect(toolResult.content).toContain("AssertionError");
    expect(toolResult.meta?.ran).toBe(true);
  });

  it("cascades trace rows away with their thread", async () => {
    await db.delete(schema.threads).where(eq(schema.threads.id, threadId));
    const remaining = await db
      .select()
      .from(schema.traceEvents)
      .where(eq(schema.traceEvents.runId, runId));
    expect(remaining).toEqual([]);
    // restore a thread so afterAll's delete is harmless
    const [fresh] = await db
      .insert(schema.threads)
      .values({ repo: `test/trace-fresh-${Date.now()}`, issueNumber: 2 })
      .returning();
    threadId = fresh!.id;
  });
});
