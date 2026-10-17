/**
 * Cross-process cancel — the interjection primitive.
 *
 * `requestCancel` sets a durable flag from ANY process; the worker's watcher
 * polls it and aborts the run. This is how a webhook/chat server stops a run
 * it has no in-process handle on (the in-process `cancelRun` fast path only
 * works inside the worker itself).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
import type { LLMClient } from "@harness/agent";
import { createDb, createPool, schema, type Db } from "../../src/db/index.js";
import { runMigrations } from "../../src/db/migrate.js";
import { executeRun } from "../../src/runs/execute.js";
import { requestCancel } from "../../src/runs/lease.js";
import { loadConfig } from "../../src/config.js";

const FIXTURE = fileURLToPath(new URL("../../../../fixtures/buggy-lib", import.meta.url));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** An LLM that blocks until aborted — so the run is genuinely in flight. */
const blockingLLM: LLMClient = {
  model: "blocking",
  async complete() {
    throw new Error("unused");
  },
  stream: (_req, _onDelta, opts) =>
    new Promise<never>((_resolve, reject) => {
      const signal = opts?.signal;
      const abort = () => reject(Object.assign(new Error("This operation was aborted"), { name: "AbortError" }));
      if (signal?.aborted) abort();
      signal?.addEventListener("abort", abort, { once: true });
    }),
};

describe("cross-process cancel", () => {
  let pool: Pool;
  let db: Db;
  let threadId: string;

  beforeAll(async () => {
    pool = createPool(loadConfig().postgres.url);
    db = createDb(pool);
    await runMigrations(db);
    const [thread] = await db
      .insert(schema.threads)
      .values({ repo: FIXTURE, issueNumber: 3 })
      .returning();
    threadId = thread!.id;
  });

  afterAll(async () => {
    await db.delete(schema.threads).where(eq(schema.threads.id, threadId));
    await pool.end();
  });

  it("requestCancel stops a running run, set from outside the worker process", async () => {
    const [run] = await db
      .insert(schema.runs)
      .values({ threadId, trigger: "manual", task: "add() ignores negative numbers" })
      .returning();

    const outcomePromise = executeRun({
      db,
      runId: run!.id,
      local: true,
      llm: blockingLLM,
      cancelWatchEveryMs: 200,
    });
    await sleep(700); // the run is now in flight, blocked on the LLM call

    await requestCancel(db, run!.id); // any process: webhook, chat API, CLI
    const outcome = await outcomePromise;

    expect(outcome.status).toBe("cancelled");
    const [row] = await db.select().from(schema.runs).where(eq(schema.runs.id, run!.id));
    expect(row!.status).toBe("cancelled");
    expect(row!.cancelRequestedAt).not.toBeNull();
    expect(row!.finishedAt).not.toBeNull();
  }, 60_000);
});
