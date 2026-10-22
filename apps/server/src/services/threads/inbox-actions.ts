import { eq } from "drizzle-orm";
import { schema, type Db } from "../../db/index.js";
import type { Queues } from "../../queue/index.js";
import type { Notifier } from "./result.js";
import { requestCancel } from "../runs/lease.js";
import { drainInbox, latestActiveRun } from "./inbox.js";

type EventRow = typeof schema.events.$inferSelect;
type ThreadRow = typeof schema.threads.$inferSelect;

/**
 * The explicit override (decision #28): a pending event forces the active run
 * to stop and become the next turn. On an idle thread it runs immediately.
 */
export async function interjectEvent(
  deps: { db: Db; queues: Queues; hub?: Notifier },
  thread: ThreadRow,
  event: EventRow,
): Promise<
  | { ok: true; action: "interjected" | "already-scheduled" | "woken" | "no-op"; runId: string | null }
  | { ok: false; reason: string }
> {
  if (event.status !== "pending") return { ok: false, reason: `event is ${event.status}` };

  const active = await latestActiveRun(deps.db, thread.id);
  if (active?.status === "running") {
    await requestCancel(deps.db, active.id);
    deps.hub?.notify(thread.id);
    return { ok: true, action: "interjected", runId: active.id };
  }
  if (active?.status === "queued") {
    // The turn is already scheduled; this event will be its input.
    return { ok: true, action: "already-scheduled", runId: active.id };
  }

  const run = await drainInbox({ db: deps.db, queues: deps.queues }, thread.id);
  deps.hub?.notify(thread.id);
  return { ok: true, action: run ? "woken" : "no-op", runId: run?.id ?? null };
}

/**
 * Withdraw a queued dashboard message. Consumed events are history; GitHub
 * events are not ours to delete.
 */
export async function withdrawEvent(
  db: Db,
  event: EventRow,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (event.kind !== "chat_message" || event.status !== "pending")
    return { ok: false, reason: "only queued dashboard messages can be withdrawn" };
  await db.delete(schema.events).where(eq(schema.events.id, event.id));
  return { ok: true };
}
