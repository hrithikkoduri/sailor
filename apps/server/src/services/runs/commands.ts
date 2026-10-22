import { eq } from "drizzle-orm";
import { schema, type Db } from "../../db/index.js";
import type { StreamHub } from "../../http/stream.js";
import { requestCancel } from "./lease.js";

type RunRow = typeof schema.runs.$inferSelect;

/**
 * Cancel a run.
 *
 * A running run gets a durable flag (decision #25): the worker's watcher
 * aborts at a turn boundary. A queued run is cancelled in place.
 */
export async function cancelRun(
  db: Db,
  hub: StreamHub,
  run: RunRow,
): Promise<{ action: "cancel-requested" | "cancelled-queued" } | { error: string }> {
  if (run.status === "running") {
    await requestCancel(db, run.id);
    hub.notify(run.threadId);
    return { action: "cancel-requested" };
  }
  if (run.status === "queued") {
    await db.update(schema.runs)
      .set({ status: "cancelled", finishedAt: new Date(), error: "cancelled before start" })
      .where(eq(schema.runs.id, run.id));
    hub.notify(run.threadId);
    return { action: "cancelled-queued" };
  }
  return { error: `run is ${run.status}` };
}

/**
 * Keep the sandbox after the run.
 *
 * Allowed before or during the run: the executor re-reads the flag right before
 * destruction, so flipping it while running wins the race.
 */
export async function keepSandbox(db: Db, hub: StreamHub, run: RunRow) {
  await db.update(schema.runs)
    .set({ keepSandbox: true })
    .where(eq(schema.runs.id, run.id));
  hub.notify(run.threadId);
}
