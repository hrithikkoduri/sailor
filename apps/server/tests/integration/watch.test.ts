/**
 * Watch wiring at the app level, end to end at the DB: run 1 concludes
 * "watch, resume at fix" → rows record it, the thread keeps "fix" as its
 * resume phase → run 2 (a later wake) actually STARTS in the fix phase.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
import { createDb, createPool, schema, type Db } from "../../src/db/index.js";
import { runMigrations } from "../../src/db/migrate.js";
import { executeRun } from "../../src/services/runs/execute.js";
import { PostgresThreadStore } from "../../src/services/threads/thread-store.js";
import { loadConfig } from "../../src/config.js";
import { scriptedLLM, type Scripted } from "../helpers/scripted-llm.js";

const FIXTURE = fileURLToPath(
  new URL("../../../../fixtures/buggy-lib", import.meta.url),
);

const FIX_STEPS: Scripted[] = [
  { tools: [{ name: "run_tests", arguments: "{}" }] }, // fails → fix
  {
    tools: [
      {
        name: "edit_file",
        arguments: JSON.stringify({
          path: "src/sum.js",
          old_string:
            "numbers.filter((n) => n >= 0).reduce((a, b) => a + b, 0)",
          new_string: "numbers.reduce((a, b) => a + b, 0)",
        }),
      },
    ],
  },
  { tools: [{ name: "run_tests", arguments: "{}" }] }, // passes → verify
];

describe("watch disposition wiring", () => {
  let pool: Pool;
  let db: Db;
  let threadId: string;

  beforeAll(async () => {
    pool = createPool(loadConfig().postgres.url);
    db = createDb(pool);
    await runMigrations(db);
    const [thread] = await db
      .insert(schema.threads)
      .values({ repo: FIXTURE, issueNumber: 21 })
      .returning();
    threadId = thread!.id;
  });

  afterAll(async () => {
    await db.delete(schema.threads).where(eq(schema.threads.id, threadId));
    await pool.end();
  });

  it("run 1: watch → run/thread rows record it and the resume phase survives", async () => {
    const [run] = await db
      .insert(schema.runs)
      .values({
        threadId,
        trigger: "manual",
        task: "add() ignores negative numbers",
      })
      .returning();
    const llm = scriptedLLM([
      ...FIX_STEPS,
      {
        tools: [
          {
            name: "finish",
            arguments: JSON.stringify({
              summary: "fixed; watching CI",
              success: true,
              handoff: {
                disposition: "watch",
                watch: { checks: true, comments: true },
                resumeAt: "act",
              },
            }),
          },
        ],
      },
    ]);

    const outcome = await executeRun({ db, runId: run!.id, local: true, llm });
    expect(outcome.status).toBe("succeeded");
    expect(outcome.disposition).toBe("watch");
    expect(outcome.resumeAt).toBe("act");

    const [runRow] = await db
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.id, run!.id));
    expect(runRow!.disposition).toBe("watch");

    const [threadRow] = await db
      .select()
      .from(schema.threads)
      .where(eq(schema.threads.id, threadId));
    expect(threadRow!.watch).toEqual({ checks: true, comments: true });

    const store = new PostgresThreadStore(db);
    expect((await store.load(threadId))?.phase).toBe("act");
  }, 120_000);

  it("run 2: a later wake starts in the phase run 1 declared", async () => {
    const [run] = await db
      .insert(schema.runs)
      .values({
        threadId,
        trigger: "inbox",
        task: "CI failed: expected add(-1,-2) to be -3",
      })
      .returning();
    const llm = scriptedLLM([
      {
        tools: [
          {
            name: "finish",
            arguments: JSON.stringify({
              summary: "ack — needs another fix round",
              success: false,
            }),
          },
        ],
      },
    ]);

    const outcome = await executeRun({ db, runId: run!.id, local: true, llm });
    expect(outcome.status).toBe("failed"); // finish(success=false) → not succeeded

    // Resume metadata survives, but the latest user request is still the
    // actual final user message — no generated PHASE command replaces it.
    const messages = llm.seen[0]!.messages;
    const opening = messages[messages.length - 1]!.content ?? "";
    expect(opening).toBe("CI failed: expected add(-1,-2) to be -3");

    const [runRow] = await db
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.id, run!.id));
    expect(runRow!.phase).toBe("act");
    expect(runRow!.disposition).toBe("blocked"); // finish(success=false) default

    // Any other declared conclusion supersedes the standing watch.
    const [threadRow] = await db
      .select()
      .from(schema.threads)
      .where(eq(schema.threads.id, threadId));
    expect(threadRow!.watch).toBeNull();
  }, 120_000);
});
