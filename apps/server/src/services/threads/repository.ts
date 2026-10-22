/** Moving a thread onto a repository (attach or switch). */
import { and, eq, inArray } from "drizzle-orm";
import { schema, type Db } from "../../db/index.js";
import { RUN_JOB_OPTIONS, type Queues } from "../../queue/index.js";
import { enabledRepositories } from "./repositories.js";
import { releaseThreadSandbox } from "../runs/execute.js";
import { CLOSED_STATES, isFailure, type Notifier, type ServiceFailure } from "./result.js";

export async function attachRepository(
  deps: { db: Db; queues: Queues; hub?: Notifier },
  actor: { userId: string; name: string },
  threadId: string,
  repoFullName: unknown,
): Promise<{ queued: boolean; runId: string | null } | ServiceFailure> {
  const repo = (await enabledRepositories(deps.db, actor.userId))
    .find((r) => r.fullName === repoFullName);
  if (!repo) return { error: "Repository is not enabled for this account.", status: 403 };

  const result = await deps.db.transaction(async (tx) => {
    const [thread] = await tx.select().from(schema.threads)
      .where(and(eq(schema.threads.id, threadId), eq(schema.threads.userId, actor.userId)))
      .for("update");
    if (!thread) return { error: "Thread not found.", status: 404 as const };
    if (thread.source !== "workspace" || CLOSED_STATES.includes(thread.state))
      return { error: "This thread already has a repository or is closed. Start a new thread to switch repositories.", status: 409 as const };
    const pending = await tx.select({ id: schema.events.id }).from(schema.events).where(and(
      eq(schema.events.threadId, thread.id), eq(schema.events.kind, "repository_attachment"),
      eq(schema.events.status, "pending"),
    ));
    if (pending.length) return { error: "An attachment is already queued for this thread.", status: 409 as const };
    const questions = await tx.select({ id: schema.questionRequests.id }).from(schema.questionRequests).where(and(
      eq(schema.questionRequests.threadId, thread.id), eq(schema.questionRequests.status, "pending"),
    ));
    if (questions.length) return { error: "Answer the pending questions before attaching a repository.", status: 409 as const };
    const active = await tx.select({ id: schema.runs.id }).from(schema.runs)
      .where(and(eq(schema.runs.threadId, thread.id), inArray(schema.runs.status, ["queued", "running"])));
    await tx.insert(schema.events).values({
      threadId: thread.id, kind: "repository_attachment",
      payload: {
        repository: repo.fullName,
        body: `Use ${repo.fullName} for this thread and continue the original request.`,
        author: actor.name,
      },
      ...(!active.length ? { status: "consumed", consumedAt: new Date() } : {}),
    });
    if (active.length) return { queued: true as const, runId: null };
    const [run] = await tx.insert(schema.runs).values({
      threadId: thread.id, trigger: "repository_attachment", agent: "coding",
      repoAttachment: repo.fullName,
      task: `The user attached ${repo.fullName}. Continue the original request in that repository.`,
    }).returning();
    return { queued: false as const, runId: run!.id };
  });
  if (isFailure(result)) return result;
  if (result.runId) await deps.queues.runs.add("run", { runId: result.runId }, RUN_JOB_OPTIONS);
  deps.hub?.notify(threadId);
  return { queued: result.queued, runId: result.runId };
}

/**
 * Move an existing thread to a different repository.
 *
 * The retained sandbox belongs to the old repository and is released, the
 * PR/branch/checkpoint pointers are reset, and the next run starts from a
 * fresh checkout of the new repository.
 */
export async function switchRepository(
  deps: { db: Db; queues: Queues; hub?: Notifier },
  actor: { userId: string; name: string },
  threadId: string,
  repoFullName: unknown,
): Promise<{ runId: string } | ServiceFailure> {
  const repo = (await enabledRepositories(deps.db, actor.userId))
    .find((r) => r.fullName === repoFullName);
  if (!repo) return { error: "Repository is not enabled for this account.", status: 403 };

  const result = await deps.db.transaction(async (tx) => {
    const [thread] = await tx.select().from(schema.threads)
      .where(and(eq(schema.threads.id, threadId), eq(schema.threads.userId, actor.userId)))
      .for("update");
    if (!thread) return { error: "Thread not found.", status: 404 as const };
    if (CLOSED_STATES.includes(thread.state))
      return { error: "This thread is closed.", status: 409 as const };
    if (thread.repo === repo.fullName && thread.source === "manual")
      return { error: "This thread already works in that repository.", status: 409 as const };
    const active = await tx.select({ id: schema.runs.id }).from(schema.runs)
      .where(and(eq(schema.runs.threadId, thread.id), inArray(schema.runs.status, ["queued", "running"])));
    if (active.length)
      return { error: "Wait for the current run to finish before switching repositories.", status: 409 as const };
    const questions = await tx.select({ id: schema.questionRequests.id }).from(schema.questionRequests)
      .where(and(eq(schema.questionRequests.threadId, thread.id), eq(schema.questionRequests.status, "pending")));
    if (questions.length)
      return { error: "Answer the pending questions before switching repositories.", status: 409 as const };

    await tx.update(schema.threads).set({
      source: "manual", repo: repo.fullName, installationId: repo.installationId,
      baseRef: repo.defaultBranch ?? "main",
      headRef: null, prNumber: null, prUrl: null,
      checkpointSha: null, checkpointRef: null,
      sandboxId: null, sandboxBackend: null,
      state: "queued", updatedAt: new Date(),
    }).where(eq(schema.threads.id, thread.id));
    await tx.insert(schema.events).values({
      threadId: thread.id, kind: "repository_attachment",
      payload: {
        repository: repo.fullName, previousRepository: thread.repo,
        body: `Switched this thread to ${repo.fullName}. Continue the original request there.`,
        author: actor.name,
      },
      status: "consumed", consumedAt: new Date(),
    });
    const [run] = await tx.insert(schema.runs).values({
      threadId: thread.id, trigger: "repository_attachment", agent: "coding",
      repoAttachment: repo.fullName,
      task: `The user switched this thread to ${repo.fullName}. Continue the original request in that repository.`,
    }).returning();
    return { runId: run!.id, previous: thread };
  });
  if (isFailure(result)) return result;

  // The retained sandbox holds the OLD repository; release it before the new
  // run boots so the next checkout cannot see the previous work.
  await releaseThreadSandbox(deps.db, result.previous).catch(() => undefined);
  await deps.queues.runs.add("run", { runId: result.runId }, RUN_JOB_OPTIONS);
  deps.hub?.notify(threadId);
  return { runId: result.runId };
}
