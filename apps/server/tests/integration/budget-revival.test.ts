/**
 * Budget revival (product side, simplified rule): a run that ends out of
 * budget with a handoff continues as a fresh run — same task, same phase,
 * same budget — until the THREAD's budget is spent. The worker's aftermath
 * call is the fast path; the sweep is the fallback when it died first.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
import { createDb, createPool, schema, type Db } from "../../src/db/index.js";
import { runMigrations } from "../../src/db/migrate.js";
import { executeRun } from "../../src/runs/execute.js";
import { handleBudgetAftermath } from "../../src/runs/revival.js";
import { sweepStaleRuns } from "../../src/runs/lease.js";
import { loadConfig } from "../../src/config.js";
import { scriptedLLM, type Scripted } from "../helpers/scripted-llm.js";

const FIXTURE = fileURLToPath(
  new URL("../../../../fixtures/buggy-lib", import.meta.url),
);

/** 110 tokens per call; max 1000 → the 85% warning fires after call 8. */
const exhaustScript: Scripted[] = [
  ...Array.from({ length: 8 }, (_, index) => ({
    tools: [
      {
        name: "bash",
        arguments: JSON.stringify({ command: `echo step ${index}` }),
      },
    ],
  })),
  {
    tools: [
      {
        name: "request_revival",
        arguments: JSON.stringify({
          remaining: "finish the parser fix and run the suite",
          estimatedSteps: 6,
          estimatedTokens: 5000,
        }),
      },
    ],
  },
  ...Array.from({ length: 3 }, (_, index) => ({
    tools: [
      {
        name: "bash",
        arguments: JSON.stringify({ command: `echo tail ${index}` }),
      },
    ],
  })),
];

describe("budget revival", () => {
  let pool: Pool;
  let db: Db;
  const createdThreads: string[] = [];

  beforeAll(async () => {
    pool = createPool(loadConfig().postgres.url);
    db = createDb(pool);
    await runMigrations(db);
  });

  afterAll(async () => {
    for (const id of createdThreads) {
      await db.delete(schema.events).where(eq(schema.events.threadId, id));
      await db.delete(schema.threads).where(eq(schema.threads.id, id));
    }
    await pool.end();
  });

  let nextIssue = 1;
  const newThread = async (values: Record<string, unknown> = {}) => {
    const [thread] = await db
      .insert(schema.threads)
      .values({
        repo: FIXTURE,
        issueNumber: nextIssue++,
        source: "local",
        ...values,
      })
      .returning();
    createdThreads.push(thread!.id);
    return thread!;
  };

  const newRun = async (threadId: string, task = "add() ignores negatives") => {
    const [run] = await db
      .insert(schema.runs)
      .values({ threadId, trigger: "manual", task })
      .returning();
    return run!;
  };

  const runToExhaustion = async (runId: string) => {
    const outcome = await executeRun({
      db,
      runId,
      local: true,
      llm: scriptedLLM(structuredClone(exhaustScript)),
      budgets: { maxTokens: 1000, maxSteps: 50 },
    });
    expect(outcome.status).toBe("budget_exhausted");
    expect(outcome.revival).toMatchObject({ estimatedTokens: 5000 });
    return outcome;
  };

  it("the death with a handoff is the cue: same task, same phase, same budget", async () => {
    const thread = await newThread();
    const run = await newRun(thread.id);
    const outcome = await runToExhaustion(run.id);

    const [row] = await db
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.id, run.id));
    expect(row!.status).toBe("budget_exhausted");
    expect(row!.revived).toBe(false);
    expect(row!.revival).toMatchObject({
      request: { estimatedTokens: 5000 },
    });

    const aftermath = await handleBudgetAftermath(db, run.id);
    expect(aftermath.revivedRunId).toBeTruthy();

    const [revival] = await db
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.id, aftermath.revivedRunId!));
    expect(revival).toMatchObject({
      threadId: thread.id,
      trigger: "revival",
      agent: "coding",
      status: "queued",
      task: "add() ignores negatives",
      startPhase: outcome.phase ?? "understand",
    });

    const [source] = await db
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.id, run.id));
    expect(source!.revived).toBe(true);

    // Idempotent: a second call does nothing.
    expect(await handleBudgetAftermath(db, run.id)).toEqual({});
  });

  it("the sweep revives a budget-dead run whose aftermath never ran", async () => {
    const thread = await newThread();
    const run = await newRun(thread.id);
    await runToExhaustion(run.id); // no immediate aftermath this time

    const swept = await sweepStaleRuns(db, { revivalGraceMs: 0 });
    const entry = swept.find((result) => result.staleRunId === run.id);
    expect(entry).toBeTruthy();

    const [revival] = await db
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.id, entry!.resumeRunId));
    expect(revival).toMatchObject({ trigger: "revival", status: "queued" });
    const [source] = await db
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.id, run.id));
    expect(source!.revived).toBe(true);
  });

  it("stops at the thread budget with a needs-human note instead", async () => {
    const thread = await newThread({ budgetMaxUsd: "0.00" });
    const run = await newRun(thread.id);
    await runToExhaustion(run.id);

    const aftermath = await handleBudgetAftermath(db, run.id);
    expect(aftermath).toEqual({ noted: true });

    const runs = await db
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.threadId, thread.id));
    expect(runs).toHaveLength(1); // no revival run

    const events = await db
      .select()
      .from(schema.events)
      .where(eq(schema.events.threadId, thread.id));
    const note = events.find((event) => event.kind === "budget_exhausted");
    expect(note).toBeTruthy();
    expect(JSON.stringify(note!.payload)).toContain("finish the parser fix");
  });
});
