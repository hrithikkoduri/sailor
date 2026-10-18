/**
 * The recovery pipeline, end to end: a worker dies (stale heartbeat) → the
 * sweep interrupts the run and enqueues a resume → a worker instance picks it
 * up → executeRun continues from the saved phase (fix) and finishes the job.
 * This is the kill-the-worker demo, minus the actual kill.
 *
 * NOTE: this test consumes the real `runs` queue — it must not run while a
 * dev worker (`npm run dev`) is up, or the job can land in the wrong process.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Worker } from "bullmq";
import { eq } from "drizzle-orm";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
import { createDb, createPool, schema, type Db } from "../../src/db/index.js";
import { runMigrations } from "../../src/db/migrate.js";
import {
  createQueueConnection,
  createQueues,
  type Queues,
  type RunJobData,
} from "../../src/queue/index.js";
import { executeRun } from "../../src/runs/execute.js";
import { PostgresThreadStore } from "../../src/threads/thread-store.js";
import { handleSweep } from "../../src/worker/sweep.js";
import { loadConfig } from "../../src/config.js";
import { scriptedLLM, type Scripted } from "../helpers/scripted-llm.js";

const FIXTURE = fileURLToPath(new URL("../../../../fixtures/buggy-lib", import.meta.url));

async function waitFor<T>(fn: () => Promise<T | undefined>, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 200));
  }
}

describe("worker recovery pipeline", () => {
  let pool: Pool;
  let db: Db;
  let queues: Queues;
  let threadId: string | undefined;
  let worker: Worker<RunJobData> | undefined;
  let workerConnection: ReturnType<typeof createQueueConnection> | undefined;

  const redisUrl = loadConfig().redis.url;

  beforeAll(async () => {
    pool = createPool(loadConfig().postgres.url);
    db = createDb(pool);
    await runMigrations(db);
    queues = createQueues(createQueueConnection(redisUrl));
  });

  afterAll(async () => {
    await worker?.close().catch(() => undefined);
    workerConnection?.disconnect();
    if (threadId) await db.delete(schema.threads).where(eq(schema.threads.id, threadId));
    await queues.close();
    await pool.end();
  });

  it("stale run → sweep → resume job → worker resumes at the saved phase and finishes", async () => {
    // 1. A thread mid-work: the conversation so far, resume position 'fix'.
    //    (issue 2: execute-run.test owns (FIXTURE, 1) — unique key isolation.)
    const [thread] = await db
      .insert(schema.threads)
      .values({ repo: FIXTURE, issueNumber: 2 })
      .returning();
    threadId = thread!.id;
    const store = new PostgresThreadStore(db);
    await store.save(threadId, {
      messages: [
        { role: "user", content: "PHASE: reproduce — produce a failing test" },
        { role: "assistant", content: null, tool_calls: [{ id: "c1", name: "run_tests", arguments: "{}" }] },
        { role: "tool", tool_call_id: "c1", content: "AssertionError: 0 !== -3" },
      ],
      phase: "fix",
    });

    // 2. The dead worker: a running run with a stale heartbeat.
    const [stale] = await db
      .insert(schema.runs)
      .values({
        threadId,
        trigger: "manual",
        task: "add() ignores negative numbers",
        status: "running",
        heartbeatAt: new Date(Date.now() - 10 * 60_000),
      })
      .returning();

    // 3. The sweep: interrupt + enqueue the resume into the runs queue.
    const results = await handleSweep({ db, queues });
    const recovered = results.find((r) => r.staleRunId === stale!.id);
    expect(recovered).toBeDefined();

    const [interrupted] = await db.select().from(schema.runs).where(eq(schema.runs.id, stale!.id));
    expect(interrupted!.status).toBe("interrupted");

    // 4. A worker instance (scripted LLM standing in for the model) picks the
    //    resume up and continues from phase 'fix'.
    const resumeScript: Scripted[] = [
      {
        tools: [
          {
            name: "edit_file",
            arguments: JSON.stringify({
              path: "src/sum.js",
              old_string: "numbers.filter((n) => n >= 0).reduce((a, b) => a + b, 0)",
              new_string: "numbers.reduce((a, b) => a + b, 0)",
            }),
          },
        ],
      },
      { tools: [{ name: "run_tests", arguments: "{}" }] }, // full suite passes (fix stays put)
      { text: "fixed after resume; existing tests pass" },
    ];
    workerConnection = createQueueConnection(redisUrl);
    worker = new Worker<RunJobData>(
      "runs",
      async (job) => {
        if (job.data.runId !== recovered!.resumeRunId) return; // only our job
        await executeRun({ db, runId: job.data.runId, local: true, llm: scriptedLLM(resumeScript) });
      },
      { connection: workerConnection },
    );

    const resumeRun = await waitFor(async () => {
      const [row] = await db.select().from(schema.runs).where(eq(schema.runs.id, recovered!.resumeRunId));
      return row && row.status === "succeeded" ? row : undefined;
    });

    expect(resumeRun!.trigger).toBe("resume");
    expect(resumeRun!.phase).toBe("understand"); // old persisted fix label is not a new instruction
    expect(resumeRun!.steps).toBe(3);

    // The thread kept its memory through the whole crash → resume arc.
    const resumed = await store.load(threadId);
    expect(resumed!.messages.length).toBeGreaterThanOrEqual(6);
    expect(resumed!.messages.some((m) => (m.content ?? "").includes("AssertionError"))).toBe(true);
  }, 120_000);
});
