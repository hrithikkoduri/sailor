/**
 * The thread lifecycle state machine.
 *
 * A thread (one issue/conversation) moves through explicit states; every
 * transition is validated. `running` means a run is active; the PR states
 * (`pr_open`, `waiting_ci`, `fixing`, `addressing_comments`) describe the
 * between-runs life and get wired by the GitHub layers (steps 12–13).
 * Terminal states are terminal: merged, closed, abandoned.
 */
import { eq } from "drizzle-orm";
import { schema, type Db } from "../../db/index.js";

export const THREAD_STATES = [
  "queued",
  "running",
  "pr_open",
  "waiting_ci",
  "fixing",
  "addressing_comments",
  "merged",
  "closed",
  "abandoned",
] as const;

export type ThreadState = (typeof THREAD_STATES)[number];

const TRANSITIONS: Record<ThreadState, readonly ThreadState[]> = {
  queued: ["running", "closed", "abandoned"],
  running: ["queued", "pr_open", "waiting_ci", "fixing", "addressing_comments", "closed", "abandoned"],
  pr_open: ["running", "waiting_ci", "fixing", "addressing_comments", "merged", "closed", "abandoned"],
  waiting_ci: ["running", "fixing", "addressing_comments", "merged", "closed", "abandoned"],
  fixing: ["running", "waiting_ci", "pr_open", "merged", "closed", "abandoned"],
  addressing_comments: ["running", "waiting_ci", "pr_open", "merged", "closed", "abandoned"],
  merged: [],
  closed: [],
  abandoned: [],
};

/** `from` may be an arbitrary string (whatever the DB holds); unknown → false. */
export function canTransition(from: string, to: ThreadState): boolean {
  return (TRANSITIONS as Record<string, readonly ThreadState[] | undefined>)[from]?.includes(to) ?? false;
}

/** Terminal = no exits: merged, closed, abandoned. Dead threads take no turns. */
export function isTerminal(state: string): boolean {
  return (TRANSITIONS as Record<string, readonly ThreadState[] | undefined>)[state]?.length === 0;
}

/** Validated transition; throws on an illegal move or a missing thread. */
export async function transitionThread(db: Db, threadId: string, to: ThreadState): Promise<void> {
  const [thread] = await db
    .select({ state: schema.threads.state })
    .from(schema.threads)
    .where(eq(schema.threads.id, threadId));
  if (!thread) throw new Error(`thread ${threadId} not found`);
  if (!canTransition(thread.state, to)) {
    throw new Error(`illegal thread transition ${thread.state} → ${to}`);
  }
  await db
    .update(schema.threads)
    .set({ state: to, updatedAt: new Date() })
    .where(eq(schema.threads.id, threadId));
}

/**
 * Tolerant variant of transitionThread: `to === from` is a no-op (returns
 * false) instead of an error. Used by run lifecycles that legitimately
 * re-enter a state (e.g. resuming a run leaves `running` → `running`).
 */
export async function ensureThreadState(db: Db, threadId: string, to: ThreadState): Promise<boolean> {
  const [thread] = await db
    .select({ state: schema.threads.state })
    .from(schema.threads)
    .where(eq(schema.threads.id, threadId));
  if (!thread) throw new Error(`thread ${threadId} not found`);
  if (thread.state === to) return false;
  if (!canTransition(thread.state, to)) throw new Error(`illegal thread transition ${thread.state} → ${to}`);
  await db
    .update(schema.threads)
    .set({ state: to, updatedAt: new Date() })
    .where(eq(schema.threads.id, threadId));
  return true;
}
