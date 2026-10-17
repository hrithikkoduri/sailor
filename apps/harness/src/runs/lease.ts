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
import { and, eq, lt } from "drizzle-orm";
import { schema, type Db } from "../db/index.js";

/** A heartbeat older than this means the worker is presumed dead. */
export const STALE_AFTER_MS = 120_000;

/** Stamp "still alive" on a running run. */
export async function heartbeatRun(db: Db, runId: string): Promise<void> {
  await db.update(schema.runs).set({ heartbeatAt: new Date() }).where(eq(schema.runs.id, runId));
}

/**
 * Durable cancel request — callable from ANY process (the webhook server, the
 * chat API, a CLI). The worker executing the run watches this flag and aborts.
 * `cancelRun()` in runs/execute.ts is the in-process fast path; this is the
 * cross-process one.
 */
export async function requestCancel(db: Db, runId: string): Promise<void> {
  await db.update(schema.runs).set({ cancelRequestedAt: new Date() }).where(eq(schema.runs.id, runId));
}

/** Beat for as long as `fn` runs; stop afterwards (success or failure). */
export async function withHeartbeat<T>(
  db: Db,
  runId: string,
  fn: () => Promise<T>,
  intervalMs = 30_000,
): Promise<T> {
  await heartbeatRun(db, runId);
  const timer = setInterval(() => {
    void heartbeatRun(db, runId).catch(() => undefined);
  }, intervalMs);
  timer.unref?.();
  try {
    return await fn();
  } finally {
    clearInterval(timer);
  }
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
export async function sweepStaleRuns(db: Db, opts: { staleAfterMs?: number } = {}): Promise<SweepResult[]> {
  const cutoff = new Date(Date.now() - (opts.staleAfterMs ?? STALE_AFTER_MS));
  const stale = await db
    .select()
    .from(schema.runs)
    .where(and(eq(schema.runs.status, "running"), lt(schema.runs.heartbeatAt, cutoff)));

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

    const [resume] = await db
      .insert(schema.runs)
      .values({ threadId: run.threadId, trigger: "resume", status: "queued" })
      .returning({ id: schema.runs.id });

    results.push({ staleRunId: run.id, threadId: run.threadId, resumeRunId: resume!.id });
  }
  return results;
}
