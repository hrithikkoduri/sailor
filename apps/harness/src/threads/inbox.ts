/**
 * The thread inbox — where events wait for their turn.
 *
 * Everything that should reach the agent lands here: GitHub webhooks (with a
 * delivery GUID), chat messages, CI results, sweeper nudges. While a run is
 * active the events just sit (`pending`); the next turn consumes the whole
 * batch at once — that IS the coalescing rule (five review comments become
 * one turn's input, not five turns).
 */
import { and, asc, eq, inArray } from "drizzle-orm";
import { schema, type Db } from "../db/index.js";
import type { Queues } from "../queue/index.js";
import { renderGithubTask } from "../github/render.js";
import { wakeThread, type WokenRun } from "./wake.js";

export interface NewEvent {
  threadId: string;
  /** Webhook delivery GUID; omit for internal events (chat, sweeper). */
  deliveryId?: string;
  kind: string;
  payload: Record<string, unknown>;
}

export async function appendEvent(db: Db, event: NewEvent) {
  const [row] = await db
    .insert(schema.events)
    .values({
      threadId: event.threadId,
      deliveryId: event.deliveryId ?? null,
      kind: event.kind,
      payload: event.payload,
    })
    .returning();
  return row!;
}

/** Pending events for a thread, oldest first — the next turn's input. */
export async function pendingEvents(db: Db, threadId: string) {
  return db
    .select()
    .from(schema.events)
    .where(and(eq(schema.events.threadId, threadId), eq(schema.events.status, "pending")))
    .orderBy(asc(schema.events.receivedAt), asc(schema.events.id));
}

/** Mark a consumed batch (the turn that processed them). */
export async function consumeEvents(db: Db, eventIds: bigint[]): Promise<void> {
  if (eventIds.length === 0) return;
  await db
    .update(schema.events)
    .set({ status: "consumed", consumedAt: new Date() })
    .where(inArray(schema.events.id, eventIds));
}

/** Render an event batch into the next turn's task (GitHub-aware, decision #28 voice). */
export function renderInboxTask(events: Array<{ kind: string; payload: unknown }>): string {
  return events
    .map((e) => renderGithubTask(e.kind, (e.payload ?? {}) as Record<string, unknown>))
    .join("\n\n");
}

/**
 * drainInbox — the post-turn consumer.
 *
 * Events that arrived while a run was active are still `pending`. When the
 * thread goes idle, the batch becomes ONE new run (coalescing): task = the
 * rendered batch, trigger "inbox". The events are consumed the moment the run
 * exists — the instruction survives in `runs.task` even if the run later
 * fails. Returns null when there is nothing to do or the thread is still busy.
 *
 * `startPhase`: a cancelled run (interjected) passes the phase it stopped in,
 * so the batch resumes there (subsumption — decision #28).
 */
export async function drainInbox(
  deps: { db: Db; queues: Queues },
  threadId: string,
  opts: { startPhase?: string } = {},
): Promise<WokenRun | null> {
  const pending = await pendingEvents(deps.db, threadId);
  if (pending.length === 0) return null;
  // A batch of nothing but dashboard messages is a CONVERSATION turn, not a
  // coding mission (decision #48): it runs the chat agent — one "respond"
  // phase, the reply IS the turn. Any GitHub/machine event makes it coding.
  const agent = pending.every((e) => e.kind === "chat_message") ? "chat" : "coding";
  const run = await wakeThread(deps, threadId, {
    trigger: "inbox",
    task: renderInboxTask(pending),
    agent,
    ...(opts.startPhase !== undefined ? { startPhase: opts.startPhase } : {}),
  });
  if (run) await consumeEvents(deps.db, pending.map((e) => e.id));
  return run;
}
