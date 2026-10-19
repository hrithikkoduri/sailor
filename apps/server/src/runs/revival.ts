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
 *
 * The decision itself is pure and lives in the package (`planRevival` +
 * `ThreadBudget`); this file is the product's persistence, note, and
 * idempotence.
 */
import { eq } from "drizzle-orm";
import { planRevival, ThreadBudget, type RevivalRequest } from "@anchor/core";
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

  // The decision is the package's (pure and reviewable); the database is ours.
  const evidence = (run.revival ?? null) as {
    request?: RevivalRequest;
    checkpointRef?: string;
  } | null;
  const plan = planRevival({
    result: {
      reason: "budget_exceeded",
      ...(evidence?.request ? { revival: evidence.request } : {}),
      ...(evidence?.checkpointRef
        ? { checkpointRef: evidence.checkpointRef }
        : {}),
      ...(run.phase ? { phase: run.phase } : {}),
    },
    task: run.task ?? "(no task recorded)",
    threadBudget: new ThreadBudget(
      { maxTurns: thread.budgetMaxTurns, maxUsd: Number(thread.budgetMaxUsd) },
      { turnsUsed: thread.turnsUsed, usdSpent: Number(thread.usdSpent) },
    ),
  });
  if (plan.action === "none") return {};
  if (plan.action === "needs_human") {
    await appendEvent(db, {
      threadId: thread.id,
      kind: "budget_exhausted",
      payload: { note: plan.note },
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
        task: plan.task,
        startPhase: plan.startPhase ?? null,
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
