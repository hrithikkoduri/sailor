/**
 * wakeThread — the one-turn-at-a-time rule.
 *
 * If a run is already active for the thread, the wake is REFUSED (returns
 * null): the event just waits in the inbox and the current/next turn's
 * coalescing picks it up. Otherwise a new run is created and queued.
 *
 * The lock is enforced by the DATABASE — a partial unique index allows at
 * most one run per thread with status in (queued, running) — so two webhook
 * requests arriving at the same instant cannot both spawn turns. This is
 * race-safe by construction, not by check-then-act.
 */
import { createRun, type NewRunSpec } from "../runs/create.js";
import type { Queues } from "../queue/index.js";
import { isUniqueViolation } from "../db/errors.js";
import { schema, type Db } from "../db/index.js";

export type WokenRun = typeof schema.runs.$inferSelect;

export async function wakeThread(
  deps: { db: Db; queues: Queues },
  threadId: string,
  spec: Pick<NewRunSpec, "trigger" | "task" | "startPhase">,
): Promise<WokenRun | null> {
  try {
    return await createRun({ db: deps.db, queues: deps.queues }, { threadId, ...spec });
  } catch (err) {
    if (isUniqueViolation(err)) return null; // an active run owns the thread's turn
    throw err;
  }
}
