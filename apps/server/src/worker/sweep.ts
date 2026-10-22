/**
 * The stale-run sweep, wired to the queue.
 *
 * `sweepStaleRuns` (lease.ts) finds dead runs and enqueues resume RUN ROWS;
 * this adds the missing half — pushing each resume into the BullMQ `runs`
 * queue so a worker actually picks it up.
 */
import type { Queues } from "../queue/index.js";
import { RUN_JOB_OPTIONS } from "../queue/index.js";
import type { Db } from "../db/index.js";
import { sweepStaleRuns, type SweepResult } from "../services/runs/lease.js";

export async function handleSweep(
  deps: { db: Db; queues: Queues },
  opts: { staleAfterMs?: number } = {},
): Promise<SweepResult[]> {
  const results = await sweepStaleRuns(deps.db, opts);
  for (const result of results) {
    await deps.queues.runs.add("run", { runId: result.resumeRunId }, RUN_JOB_OPTIONS);
  }
  return results;
}
