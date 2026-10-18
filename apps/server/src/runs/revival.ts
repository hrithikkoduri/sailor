/**
 * Budget revival — the product half of the simplified rule.
 *
 * The death itself is the cue: a run that ended out of budget with a handoff
 * (a revival request and/or a checkpoint — stored on `runs.revival`) continues
 * as a fresh run with the SAME task, the same phase, and the SAME budget. The
 * stop condition is the thread's own budget: once its turns/dollars are spent,
 * no more revivals — the thread gets a clear note for a human instead.
 *
 * Two callers, one function: the worker right after the run ends (the fast
 * path), and the sweep (the fallback when the fast path died with its worker).
 * `revived` on the run row makes both idempotent.
 */
import { eq } from "drizzle-orm";
import { schema, type Db } from "../db/index.js";
import { isUniqueViolation } from "../db/errors.js";
import { appendEvent } from "../threads/inbox.js";
import { isTerminal } from "../threads/state.js";

export interface BudgetAftermath {
  /** The revival run that was queued (row created; the caller enqueues it). */
  revivedRunId?: string;
  /** No revival possible — a needs-human note was posted instead. */
  noted?: boolean;
}

export async function handleBudgetAftermath(
  db: Db,
  runId: string,
): Promise<BudgetAftermath> {
  const [run] = await db
    .select()
    .from(schema.runs)
    .where(eq(schema.runs.id, runId));
  if (
    !run ||
    run.status !== "budget_exhausted" ||
    run.revived ||
    run.revival == null
  )
    return {};
  const [thread] = await db
    .select()
    .from(schema.threads)
    .where(eq(schema.threads.id, run.threadId));
  if (!thread || isTerminal(thread.state)) return {};

  const budgetLeft =
    thread.turnsUsed < thread.budgetMaxTurns &&
    Number(thread.usdSpent) < Number(thread.budgetMaxUsd);
  if (!budgetLeft) {
    await appendEvent(db, {
      threadId: thread.id,
      kind: "budget_exhausted",
      payload: {
        note:
          "The thread's budget is spent, so this run was not revived — a human needs to raise the budget or narrow the task. Still remaining (per the agent): " +
          remainingText(run.revival),
      },
    });
    await db
      .update(schema.runs)
      .set({ revived: true })
      .where(eq(schema.runs.id, run.id));
    return { noted: true };
  }

  let revived: { id: string } | undefined;
  try {
    [revived] = await db
      .insert(schema.runs)
      .values({
        threadId: thread.id,
        trigger: "revival",
        agent: run.agent,
        task: run.task ?? null,
        startPhase: run.phase ?? null,
        status: "queued",
      })
      .returning({ id: schema.runs.id });
  } catch (err) {
    // One active run per thread is enforced by the DB; someone else owns the
    // turn — leave `revived` false so the next sweep retries.
    if (isUniqueViolation(err)) return {};
    throw err;
  }
  await db
    .update(schema.runs)
    .set({ revived: true })
    .where(eq(schema.runs.id, run.id));
  return { revivedRunId: revived!.id };
}

/** The agent's own words about what remains, for the needs-human note. */
function remainingText(revival: unknown): string {
  const request = (revival as { request?: { remaining?: unknown } } | null)
    ?.request;
  return typeof request?.remaining === "string" && request.remaining.trim()
    ? request.remaining.trim()
    : "not stated";
}
