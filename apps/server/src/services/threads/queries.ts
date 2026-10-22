/**
 * Thread read queries (service layer).
 *
 * Routes call these and shape the response; they never assemble SQL. The list
 * query is the hottest read in the product, so it fetches exactly one run per
 * thread (DISTINCT ON) instead of every run the thread ever had.
 */
import { and, asc, desc, eq, inArray, notInArray, or, sql } from "drizzle-orm";
import { projectConversation } from "anchor-ai-sdk";
import { pendingEvents } from "./inbox.js";
import { schema, type Db } from "../../db/index.js";

type ThreadRow = typeof schema.threads.$inferSelect;
type RunRow = typeof schema.runs.$inferSelect;

/**
 * Threads visible to a user: their own, plus legacy installation-owned rows
 * that predate user accounts (never another user's).
 */
export function visibleThreadWhere(userId: string) {
  return sql`(${schema.threads.userId} = ${userId} OR (${schema.threads.userId} IS NULL AND ${schema.threads.installationId} IS NULL))`;
}

export interface ThreadListData {
  threads: ThreadRow[];
  /** Latest run per thread, keyed by thread id. */
  latest: Map<string, RunRow>;
  /** Count of pending (unconsumed) inbox events per thread. */
  pendingCount: Map<string, number>;
}

export async function threadListData(
  db: Db,
  userId: string,
  limit = 100,
): Promise<ThreadListData> {
  const threads = await db
    .select()
    .from(schema.threads)
    .where(visibleThreadWhere(userId))
    .orderBy(desc(schema.threads.updatedAt))
    .limit(limit);
  const ids = threads.map((t) => t.id);
  if (ids.length === 0) return { threads, latest: new Map(), pendingCount: new Map() };

  // One run per thread. `DISTINCT ON` needs the ordering to lead with the
  // distinct key, then the tiebreaker we actually want (newest).
  const latestIds = await db.execute<{ id: string }>(sql`
    SELECT DISTINCT ON (thread_id) id
    FROM runs
    WHERE thread_id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
    ORDER BY thread_id, created_at DESC
  `);
  const runIds = latestIds.rows.map((row) => row.id);
  const runs = runIds.length
    ? await db.select().from(schema.runs).where(inArray(schema.runs.id, runIds))
    : [];

  const pending = await db
    .select({ threadId: schema.events.threadId, count: sql<number>`count(*)::int` })
    .from(schema.events)
    .where(and(inArray(schema.events.threadId, ids), eq(schema.events.status, "pending")))
    .groupBy(schema.events.threadId);

  return {
    threads,
    latest: new Map(runs.map((run) => [run.threadId, run])),
    pendingCount: new Map(
      pending.filter((row) => row.threadId).map((row) => [row.threadId!, row.count]),
    ),
  };
}

/** Everything the thread view needs, in one read path. */
export async function threadDetailData(db: Db, thread: ThreadRow) {
  const runs = await db.select().from(schema.runs)
    .where(eq(schema.runs.threadId, thread.id))
    .orderBy(desc(schema.runs.createdAt));
  const pending = await pendingEvents(db, thread.id);
  const questions = await db.select().from(schema.questionRequests)
    .where(eq(schema.questionRequests.threadId, thread.id))
    .orderBy(asc(schema.questionRequests.createdAt));
  const events = await db.select().from(schema.events)
    .where(eq(schema.events.threadId, thread.id))
    .orderBy(asc(schema.events.id))
    .limit(200);
  const [installation] = thread.installationId != null
    ? await db.select({ accountLogin: schema.installations.accountLogin })
        .from(schema.installations)
        .where(eq(schema.installations.installationId, thread.installationId))
    : [];

  // Finished calls carry full text; only active runs need individual deltas
  // for refresh-mid-stream hydration. One query, not one query per turn.
  const runIds = runs.map((r) => r.id);
  const activeIds = runs.filter((r) => ["queued", "running"].includes(r.status)).map((r) => r.id);
  const nonDelta = notInArray(schema.traceEvents.type, ["llm_text_delta", "llm_reasoning_delta"]);
  const journal = runIds.length
    ? await db.select({
        runId: schema.traceEvents.runId,
        seq: schema.traceEvents.seq,
        type: schema.traceEvents.type,
        payload: schema.traceEvents.payload,
      }).from(schema.traceEvents)
        .where(and(
          inArray(schema.traceEvents.runId, runIds),
          activeIds.length ? or(nonDelta, inArray(schema.traceEvents.runId, activeIds)) : nonDelta,
        ))
        .orderBy(asc(schema.traceEvents.seq))
    : [];
  const conversations = new Map(
    runs.map((run) => [
      run.id,
      projectConversation(journal.filter((row) => row.runId === run.id), run.status),
    ]),
  );

  return {
    runs,
    events,
    questions,
    pendingEvents: pending,
    installationAccount: installation?.accountLogin ?? null,
    conversations,
  };
}

/** Whole-thread trace for the explorer: deltas dropped, heavy output trimmed. */
export async function threadTraceData(db: Db, thread: ThreadRow) {
  const runs = await db.select().from(schema.runs)
    .where(eq(schema.runs.threadId, thread.id))
    .orderBy(asc(schema.runs.createdAt));
  const runIds = runs.map((r) => r.id);
  const rows = runIds.length
    ? await db.select().from(schema.traceEvents)
        .where(and(
          inArray(schema.traceEvents.runId, runIds),
          notInArray(schema.traceEvents.type, ["llm_text_delta", "llm_reasoning_delta"]),
        ))
        .orderBy(asc(schema.traceEvents.runId), asc(schema.traceEvents.seq))
    : [];

  const spans = rows.map((e) => {
    let payload = e.payload as Record<string, unknown>;
    const content = payload.content;
    if (e.type === "tool_result" && typeof content === "string" && content.length > 4000) {
      payload = { ...payload, content: `${content.slice(0, 4000)}\n… (truncated)` };
    }
    return { id: String(e.id), runId: e.runId, seq: e.seq, type: e.type, payload, ts: e.ts };
  });

  return { runs, spans };
}

/** The journal exactly as recorded — exports trim nothing. */
export async function threadTraceExportData(db: Db, thread: ThreadRow) {
  const runs = await db.select().from(schema.runs)
    .where(eq(schema.runs.threadId, thread.id))
    .orderBy(asc(schema.runs.createdAt));
  const runIds = runs.map((r) => r.id);
  const rows = runIds.length
    ? await db.select().from(schema.traceEvents)
        .where(inArray(schema.traceEvents.runId, runIds))
        .orderBy(asc(schema.traceEvents.runId), asc(schema.traceEvents.seq))
    : [];
  return { runs, spans: rows };
}

/** One thread row by id (no ownership check — callers apply visibility). */
export async function findThread(db: Db, threadId: string) {
  const [thread] = await db.select().from(schema.threads)
    .where(eq(schema.threads.id, threadId));
  return thread;
}
