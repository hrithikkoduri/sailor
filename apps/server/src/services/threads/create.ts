/** Creating, renaming, and deleting threads. */
import { randomInt, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { schema, type Db } from "../../db/index.js";
import { RUN_JOB_OPTIONS, type Queues } from "../../queue/index.js";
import { enabledRepositories } from "./repositories.js";
import { releaseThreadSandbox } from "../runs/execute.js";
import { hasActiveRun, ownedThread, type Notifier, type ServiceFailure } from "./result.js";

export async function createThreadFromMessage(
  deps: { db: Db; queues: Queues; hub?: Notifier },
  actor: { userId: string; name: string },
  input: { text: string; repoName?: string },
): Promise<
  | { thread: typeof schema.threads.$inferSelect; runId: string }
  | ServiceFailure
> {
  const text = input.text.trim();
  if (!text || text.length > 8000)
    return { error: "Enter an instruction (8000 characters max).", status: 400 };

  const repo = input.repoName
    ? (await enabledRepositories(deps.db, actor.userId)).find((r) => r.fullName === input.repoName)
    : undefined;
  if (input.repoName && !repo)
    return { error: "Repository is not enabled for your account.", status: 403 };

  const id = randomUUID();
  // No synthetic issue is created: the negative number only satisfies the
  // legacy dedup column. `source` distinguishes on-demand work from issues.
  const created = await deps.db.transaction(async (tx) => {
    const [thread] = await tx.insert(schema.threads).values({
      id,
      title: text.split("\n")[0]!.slice(0, 160),
      userId: actor.userId,
      source: repo ? "manual" : "workspace",
      repo: repo?.fullName ?? `workspace:${id}`,
      issueNumber: -randomInt(1, 2_000_000_000),
      installationId: repo?.installationId ?? null,
      baseRef: repo?.defaultBranch ?? "main",
    }).returning();
    const [run] = await tx.insert(schema.runs)
      .values({ threadId: id, trigger: "manual", task: text, agent: "coding" }).returning();
    await tx.insert(schema.events).values({
      threadId: id, kind: "chat_message",
      payload: { body: text, author: actor.name, via: "dashboard" },
      status: "consumed", consumedAt: new Date(),
    });
    return { thread: thread!, run: run! };
  });
  await deps.queues.runs.add("run", { runId: created.run.id }, RUN_JOB_OPTIONS);
  deps.hub?.notify(id);
  return { thread: created.thread, runId: created.run.id };
}

export async function renameThread(
  deps: { db: Db; hub?: Notifier },
  actor: { userId: string },
  threadId: string,
  rawTitle: unknown,
): Promise<{ title: string } | ServiceFailure> {
  const title = typeof rawTitle === "string" ? rawTitle.trim() : "";
  if (!title || title.length > 160)
    return { error: "Use a title between 1 and 160 characters.", status: 400 };
  const [thread] = await deps.db.update(schema.threads)
    .set({ title, updatedAt: new Date() })
    .where(and(eq(schema.threads.id, threadId), eq(schema.threads.userId, actor.userId)))
    .returning();
  if (!thread) return { error: "Thread not found.", status: 404 };
  deps.hub?.notify(thread.id);
  return { title };
}

/**
 * Delete a thread and everything that belongs to it.
 *
 * A live run owns the sandbox, so deletion is refused while one is queued or
 * running. Events are deleted explicitly (their FK is `set null`, which would
 * otherwise leave orphan rows), and the retained sandbox is released before
 * the rows disappear.
 */
export async function deleteThread(
  deps: { db: Db },
  actor: { userId: string },
  threadId: string,
): Promise<{ ok: true } | ServiceFailure> {
  const thread = await ownedThread(deps.db, actor.userId, threadId);
  if (!thread) return { error: "Thread not found.", status: 404 };
  if (await hasActiveRun(deps.db, thread.id))
    return { error: "Stop the current run before deleting this thread.", status: 409 };

  await releaseThreadSandbox(deps.db, thread).catch(() => undefined);
  await deps.db.transaction(async (tx) => {
    await tx.delete(schema.events).where(eq(schema.events.threadId, thread.id));
    await tx.delete(schema.runs).where(eq(schema.runs.threadId, thread.id));
    await tx.delete(schema.threads).where(eq(schema.threads.id, thread.id));
  });
  return { ok: true };
}
