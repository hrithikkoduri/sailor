/**
 * Live usage accrual: the runs row feeds the trace header, the thread rail and
 * every other reader — so tokens/dollars must land on it as LLM calls finish,
 * not only when the run ends. The end-of-run write stays authoritative.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
import type { LLMClient } from "anchor-ai-sdk";
import { createDb, createPool, schema, type Db } from "../../src/db/index.js";
import { runMigrations } from "../../src/db/migrate.js";
import { executeRun } from "../../src/services/runs/execute.js";
import { loadConfig } from "../../src/config.js";
import { scriptedLLM, type Scripted } from "../helpers/scripted-llm.js";

const FIXTURE = fileURLToPath(
  new URL("../../../../fixtures/buggy-lib", import.meta.url),
);

describe("live usage accrual", () => {
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

  it("the row shows tokens while the run is still live", async () => {
    const [thread] = await db
      .insert(schema.threads)
      .values({ repo: FIXTURE, issueNumber: 4242, source: "local" })
      .returning();
    createdThreads.push(thread!.id);
    const [run] = await db
      .insert(schema.runs)
      .values({ threadId: thread!.id, trigger: "manual", task: "live usage" })
      .returning();

    const script: Scripted[] = [
      {
        tools: [
          { name: "bash", arguments: JSON.stringify({ command: "echo one" }) },
        ],
        usage: { costUsd: 0.001 },
      },
      {
        tools: [
          { name: "bash", arguments: JSON.stringify({ command: "echo two" }) },
        ],
        usage: { costUsd: 0.001 },
      },
      {
        tools: [
          { name: "finish", arguments: JSON.stringify({ summary: "done" }) },
        ],
        usage: { costUsd: 0.001 },
      },
    ];
    const base = scriptedLLM(script);
    // Hold the SECOND call open: by then the first call's usage has been
    // recorded, so the test can observe the row mid-run and then release.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let calls = 0;
    const llm: LLMClient = {
      model: base.model,
      complete: base.complete,
      stream: async (req, onDelta) => {
        const res = await base.stream(req, onDelta);
        calls += 1;
        if (calls === 2) await gate;
        return res;
      },
    };

    const running = executeRun({
      db,
      runId: run!.id,
      local: true,
      llm,
      budgets: { maxSteps: 12 },
    });

    await expect
      .poll(
        async () => {
          const [row] = await db
            .select()
            .from(schema.runs)
            .where(eq(schema.runs.id, run!.id));
          return row!.tokensIn;
        },
        { timeout: 8000 },
      )
      .toBeGreaterThan(0);

    release();
    const outcome = await running;
    expect(outcome.status).toBe("succeeded");

    // The end-of-run write stays authoritative: three calls at the scripted
    // 100/10 tokens and $0.001 each.
    const [final] = await db
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.id, run!.id));
    expect(final!.tokensIn).toBe(300);
    expect(final!.tokensOut).toBe(30);
    expect(Number(final!.usd)).toBeCloseTo(0.003, 6);
  }, 30_000);
});
