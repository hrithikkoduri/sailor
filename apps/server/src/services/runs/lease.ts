/**
 * Run leases — the crash detector.
 *
 * A worker stamps `runs.heartbeat_at` while it executes ("still alive"). If
 * the stamps go stale, the process died: the sweep marks the run
 * `interrupted` and enqueues a **resume** run for the same thread. The resume
 * rebuilds the conversation (ThreadStore) and the workspace (the checkpoint
 * commit) and continues — no human involved.
 *
 * This is the app half of durable turns; the package half is
 * `pauseAfterPhase` + per-turn thread persistence + checkpoints.
 */
import { and, eq, isNotNull, lt } from "drizzle-orm";
import { isUniqueViolation } from "../../db/errors.js";
import { schema, type Db } from "../../db/index.js";
import { handleBudgetAftermath } from "./revival.js";

/** A heartbeat older than this means the worker is presumed dead. */
export const STALE_AFTER_MS = 120_000;

/** Stamp "still alive" on a running run. */
export async function heartbeatRun(db: Db, runId: string): Promise<void> {
  await db
    .update(schema.runs)
    .set({ heartbeatAt: new Date() })
    .where(eq(schema.runs.id, runId));
}

/**
 * Durable cancel request — callable from ANY process (the webhook server, the
 * chat API, a CLI). The worker executing the run watches this flag and aborts.
 * `cancelRun()` in runs/execute.ts is the in-process fast path; this is the
 * cross-process one.
 */
export async function requestCancel(db: Db, runId: string): Promise<void> {
  await db
    .update(schema.runs)
    .set({ cancelRequestedAt: new Date() })
    .where(eq(schema.runs.id, runId));
}

export interface SweepResult {
  staleRunId: string;
  threadId: string;
  resumeRunId: string;
}

/**
 * Find stale runs, mark them interrupted, enqueue a resume run for each.
 * The status flip is conditional on the run still being `running`, so two
 * concurrent sweeps can't double-recover the same run.
 */
export async function sweepStaleRuns(
  db: Db,
  opts: { staleAfterMs?: number; revivalGraceMs?: number } = {},
): Promise<SweepResult[]> {
  const cutoff = new Date(Date.now() - (opts.staleAfterMs ?? STALE_AFTER_MS));
  const stale = await db
    .select()
    .from(schema.runs)
    .where(
      and(
        eq(schema.runs.status, "running"),
        lt(schema.runs.heartbeatAt, cutoff),
      ),
    );

  const results: SweepResult[] = [];
  for (const run of stale) {
    const updated = await db
      .update(schema.runs)
      .set({
        status: "interrupted",
        error: "stale heartbeat — recovered by sweep",
        finishedAt: new Date(),
      })
      .where(and(eq(schema.runs.id, run.id), eq(schema.runs.status, "running")))
      .returning({ id: schema.runs.id });
    if (updated.length === 0) continue; // another sweep won the race

    // The unique index allows one active run per thread; if something else
    // already owns the turn, the resume is skipped (the work isn't lost —
    // the next sweep or wake will retry).
    let resume: { id: string } | undefined;
    try {
      [resume] = await db
        .insert(schema.runs)
        .values({
          threadId: run.threadId,
          trigger: "resume",
          agent: run.agent,
          status: "queued",
        })
        .returning({ id: schema.runs.id });
    } catch (err) {
      if (isUniqueViolation(err)) continue;
      throw err;
    }

    results.push({
      staleRunId: run.id,
      threadId: run.threadId,
      resumeRunId: resume!.id,
    });
  }

  // Budget-dead runs whose aftermath never happened (the worker died between
  // the run ending and the revival being queued): the fallback cue. Same
  // recovery as the stale case — same task, same budget — via the shared
  // helper. The grace period lets the fast path settle first.
  const budgetCutoff = new Date(Date.now() - (opts.revivalGraceMs ?? 15_000));
  const budgetDead = await db
    .select({ id: schema.runs.id, threadId: schema.runs.threadId })
    .from(schema.runs)
    .where(
      and(
        eq(schema.runs.status, "budget_exhausted"),
        eq(schema.runs.revived, false),
        isNotNull(schema.runs.revival),
        lt(schema.runs.finishedAt, budgetCutoff),
      ),
    );
  for (const run of budgetDead) {
    const aftermath = await handleBudgetAftermath(db, run.id);
    if (aftermath.revivedRunId)
      results.push({
        staleRunId: run.id,
        threadId: run.threadId,
        resumeRunId: aftermath.revivedRunId,
      });
  }
  return results;
}
