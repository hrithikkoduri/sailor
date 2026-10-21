/**
 * executeRun integration test — a full DB-backed run with a scripted LLM and
 * a real local sandbox: status transitions, usage, thread persistence, trace
 * rows, and the checkpoint pointer all recorded.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
import { createDb, createPool, schema, type Db } from "../../src/db/index.js";
import { runMigrations } from "../../src/db/migrate.js";
import { executeRun, releaseThreadSandbox } from "../../src/runs/execute.js";
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
    const frames: Record<string, unknown>[] = [];
    const llm = scriptedLLM(FIX_FIXTURE_SCRIPT);
    const stream = llm.stream.bind(llm);
    llm.stream = async (request, onDelta, options) => {
      onDelta("Live progress");
      // Publication is synchronous, not queued behind the journal's DB I/O.
      expect(frames.at(-1), JSON.stringify(frames.at(-1))).toMatchObject({ kind: "delta", text: "Live progress" });
      return stream(request, onDelta, options);
    };
    const outcome = await executeRun({ db, runId, local: true, llm, live: (_threadId, frame) => frames.push(frame) });

    const [recorded] = await db.select().from(schema.runs).where(eq(schema.runs.id, runId));
    expect(outcome.status, recorded?.error ?? JSON.stringify(outcome)).toBe("succeeded");
    expect(outcome.summary).toContain("fixed negatives");
    // Secrets are usable by the agent, alongside the coding toolbox.
    expect(llm.seen[0]!.tools?.map((tool) => tool.function.name)).toContain("run_with_secret");

    const [run] = await db.select().from(schema.runs).where(eq(schema.runs.id, runId));
    expect(run!.status).toBe("succeeded");
    expect(run!.steps).toBe(4);
    expect(run!.tokensIn).toBe(400);
    expect(run!.tokensOut).toBe(40);
    expect(run!.phase).toBe("understand"); // descriptive labels are not mandatory transitions
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
    const traceRows = await db.select().from(schema.traceEvents).where(eq(schema.traceEvents.runId, runId)).orderBy(asc(schema.traceEvents.seq));
    expect(traceRows.length).toBeGreaterThanOrEqual(10);
    // SQL has no implicit row ordering; assert the explicit journal sequence.
    expect(traceRows.map((r) => r.seq)).toEqual(Array.from({ length: traceRows.length }, (_, i) => i));
  }, 120_000);

  it("questions stop the agent immediately and a later run resumes the same workspace", async () => {
    const [workspace] = await db.insert(schema.threads).values({ source: "workspace", repo: `workspace:questions-${Date.now()}`, issueNumber: -1, title: "A new task" }).returning();
    try {
      const [first] = await db.insert(schema.runs).values({ threadId: workspace!.id, trigger: "manual", task: "Build a converter" }).returning();
      const llm = scriptedLLM([{ tools: [
        { name: "ask_questions", arguments: JSON.stringify({ title: "Choose output", questions: [{ id: "format", label: "Which format?", type: "text" }] }) },
        { name: "bash", arguments: JSON.stringify({ command: "touch should-not-exist" }) },
      ] }]);
      const paused = await executeRun({ db, runId: first!.id, local: true, llm, revival: false });
      expect(paused.status).toBe("paused");
      expect(llm.seen).toHaveLength(1);
      const [saved] = await db.select().from(schema.threads).where(eq(schema.threads.id, workspace!.id));
      expect(saved!.sandboxId).toBeTruthy();
      const forms = await db.select().from(schema.questionRequests).where(eq(schema.questionRequests.threadId, workspace!.id));
      expect(forms).toHaveLength(1);
      expect(forms[0]!.status).toBe("pending");
      await db.update(schema.questionRequests).set({ status: "answered", answers: { format: "JSON" }, answeredAt: new Date() }).where(eq(schema.questionRequests.id, forms[0]!.id));
      const [second] = await db.insert(schema.runs).values({ threadId: workspace!.id, trigger: "answers", task: "Which format? JSON. Continue the original task." }).returning();
      const resumedLlm = scriptedLLM([{ tools: [{ name: "bash", arguments: JSON.stringify({ command: "test ! -e should-not-exist" }) }] }, { text: "Continuing with JSON." }]);
      const resumed = await executeRun({ db, runId: second!.id, local: true, llm: resumedLlm, revival: false });
      expect(resumed.status).toBe("succeeded");
      expect(resumedLlm.seen[0]!.messages.some((m) => m.content === "Build a converter")).toBe(true);
      const [after] = await db.select().from(schema.threads).where(eq(schema.threads.id, workspace!.id));
      expect(after!.sandboxId).toBe(saved!.sandboxId);
      await releaseThreadSandbox(db, after!);
    } finally { await db.delete(schema.threads).where(eq(schema.threads.id, workspace!.id)); }
  }, 120_000);
});
