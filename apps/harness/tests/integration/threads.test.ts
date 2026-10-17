/**
 * Threads integration test — inbox, the one-turn-at-a-time lock, and the
 * validated state machine. Needs the stack (`docker compose up -d`).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Pool } from "pg";
import { createDb, createPool, schema, type Db } from "../../src/db/index.js";
import { runMigrations } from "../../src/db/migrate.js";
import { createQueueConnection, createQueues, type Queues } from "../../src/queue/index.js";
import { appendEvent, consumeEvents, pendingEvents } from "../../src/threads/inbox.js";
import { transitionThread } from "../../src/threads/state.js";
import { wakeThread } from "../../src/threads/wake.js";
import { loadConfig } from "../../src/config.js";

describe("threads: inbox + wake lock + state machine", () => {
  let pool: Pool;
  let db: Db;
  let queues: Queues;
  const threadIds: string[] = [];

  const newThread = async (issue: number) => {
    const [thread] = await db
      .insert(schema.threads)
      .values({ repo: `test/threads-${Date.now()}-${issue}`, issueNumber: issue })
      .returning();
    threadIds.push(thread!.id);
    return thread!.id;
  };

  beforeAll(async () => {
    pool = createPool(loadConfig().postgres.url);
    db = createDb(pool);
    await runMigrations(db);
    queues = createQueues(createQueueConnection(loadConfig().redis.url));
  });

  afterAll(async () => {
    for (const id of threadIds) await db.delete(schema.threads).where(eq(schema.threads.id, id));
    await queues.close();
    await pool.end();
  });

  it("inbox: events append, read oldest-first, and consume as a batch", async () => {
    const threadId = await newThread(1);
    await appendEvent(db, { threadId, kind: "issue_comment", payload: { body: "first" } });
    await appendEvent(db, { threadId, kind: "chat_message", payload: { text: "second" } });

    const pending = await pendingEvents(db, threadId);
    expect(pending.map((e) => e.kind)).toEqual(["issue_comment", "chat_message"]);

    await consumeEvents(db, pending.map((e) => e.id)); // one batch = one turn's input
    expect(await pendingEvents(db, threadId)).toEqual([]);
  });

  it("wakeThread creates a run; a second wake while active is refused", async () => {
    const threadId = await newThread(2);

    const run1 = await wakeThread({ db, queues }, threadId, { trigger: "manual", task: "first" });
    expect(run1).not.toBeNull();
    expect(run1!.status).toBe("queued");

    // The event just waits: the active run owns the thread's turn.
    const refused = await wakeThread({ db, queues }, threadId, { trigger: "manual", task: "second" });
    expect(refused).toBeNull();

    // Run 1 finishes (simulated) → the next wake succeeds.
    await db
      .update(schema.runs)
      .set({ status: "succeeded", finishedAt: new Date() })
      .where(eq(schema.runs.id, run1!.id));
    const run3 = await wakeThread({ db, queues }, threadId, { trigger: "manual", task: "third" });
    expect(run3).not.toBeNull();
  });

  it("concurrent wakes create EXACTLY one run — the DB lock, not check-then-act", async () => {
    const threadId = await newThread(3);

    const results = await Promise.all(
      [1, 2, 3].map((i) => wakeThread({ db, queues }, threadId, { trigger: "manual", task: `c${i}` })),
    );
    expect(results.filter((r) => r !== null)).toHaveLength(1);
  });

  it("transitionThread validates against the machine", async () => {
    const threadId = await newThread(4);

    await transitionThread(db, threadId, "running");
    await expect(transitionThread(db, threadId, "merged")).rejects.toThrow(/illegal thread transition/);
    await transitionThread(db, threadId, "pr_open"); // legal from running

    const [thread] = await db.select().from(schema.threads).where(eq(schema.threads.id, threadId));
    expect(thread!.state).toBe("pr_open");
  });
});
