/**
 * Thread use cases (service layer).
 *
 * Each function owns the rules and the transaction; the HTTP layer only
 * authenticates, parses, and maps the result to a status code. Anything that
 * fails with a user-visible reason returns a `ServiceFailure` instead of
 * throwing, so routes stay free of domain logic.
 */
import { randomInt, randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { schema, type Db } from "../../db/index.js";
import { RUN_JOB_OPTIONS, type Queues } from "../../queue/index.js";
import { enabledRepositories } from "./repositories.js";
import { validateAnswers, type Question } from "./questions.js";
import { appendEvent, drainInbox, latestActiveRun } from "./inbox.js";
import { isTerminal } from "./state.js";
import { releaseThreadSandbox } from "../runs/execute.js";

export interface ServiceFailure {
  error: string;
  status: 400 | 403 | 404 | 409;
}

export interface Notifier {
  notify(threadId: string): void;
}

const isFailure = (value: unknown): value is ServiceFailure =>
  typeof value === "object" && value !== null && "error" in value && "status" in value;

export { isFailure };

const CLOSED = ["merged", "closed", "abandoned"];

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

export async function answerQuestions(
  deps: { db: Db; queues: Queues; hub?: Notifier },
  actor: { userId: string; name: string },
  requestId: string,
  rawAnswers: unknown,
): Promise<{ runId: string; threadId: string } | ServiceFailure> {
  const [request] = await deps.db.select().from(schema.questionRequests)
    .where(eq(schema.questionRequests.id, requestId));
  if (!request) return { error: "Question not found.", status: 404 };
  const [thread] = await deps.db.select().from(schema.threads)
    .where(eq(schema.threads.id, request.threadId));
  if (!thread || thread.userId !== actor.userId)
    return { error: "Question not found.", status: 404 };
  if (CLOSED.includes(thread.state)) return { error: "Thread is closed.", status: 409 };

  const questions = request.questions as Question[];
  let answers: Record<string, string | string[]>;
  try {
    answers = validateAnswers(questions, rawAnswers);
  } catch (err) {
    return { error: (err as Error).message, status: 400 };
  }

  // A repository answer is re-authorized here, not trusted from the form.
  const repositoryQuestion = questions.find((q) => q.type === "repository");
  const selected = repositoryQuestion ? answers[repositoryQuestion.id] : undefined;
  const repo = typeof selected === "string" && selected
    ? (await enabledRepositories(deps.db, actor.userId)).find((r) => r.fullName === selected)
    : undefined;
  if (selected && (!repo || thread.source !== "workspace"))
    return { error: "Repository is no longer available, or one is already attached.", status: 409 };

  const task = "Answers to your questions:\n\n" + questions.map((q) =>
    `${q.label}\n${Array.isArray(answers[q.id]) ? (answers[q.id] as string[]).join(", ") : answers[q.id] || "(not provided)"}`,
  ).join("\n\n") + "\n\nContinue the original request with these answers.";

  // Row lock + conditional status: two tabs cannot both start the continuation.
  const next = await deps.db.transaction(async (tx) => {
    const [locked] = await tx.select().from(schema.threads)
      .where(eq(schema.threads.id, thread.id)).for("update");
    const active = await tx.select({ id: schema.runs.id }).from(schema.runs).where(and(
      eq(schema.runs.threadId, thread.id), inArray(schema.runs.status, ["queued", "running"]),
    ));
    if (!locked || active.length) return undefined;
    const updated = await tx.update(schema.questionRequests)
      .set({ answers, status: "answered", answeredAt: new Date() })
      .where(and(eq(schema.questionRequests.id, request.id), eq(schema.questionRequests.status, "pending")))
      .returning();
    if (!updated.length) return undefined;
    await tx.insert(schema.events).values({
      threadId: thread.id, kind: "question_answers",
      payload: { body: task, requestId: request.id, answers, author: actor.name },
      status: "consumed", consumedAt: new Date(),
    });
    const [run] = await tx.insert(schema.runs).values({
      threadId: thread.id, trigger: "answers", task, agent: "coding",
      ...(repo ? { repoAttachment: repo.fullName } : {}),
    }).returning();
    return run!;
  });
  if (!next)
    return { error: "Already answered, or the agent is still pausing. Try again in a moment.", status: 409 };

  await deps.queues.runs.add("run", { runId: next.id }, RUN_JOB_OPTIONS);
  deps.hub?.notify(thread.id);
  return { runId: next.id, threadId: thread.id };
}

async function ownedThread(db: Db, userId: string, threadId: string) {
  const [thread] = await db.select().from(schema.threads)
    .where(and(eq(schema.threads.id, threadId), eq(schema.threads.userId, userId)));
  return thread;
}

async function hasActiveRun(db: Db, threadId: string) {
  const rows = await db.select({ id: schema.runs.id }).from(schema.runs)
    .where(and(eq(schema.runs.threadId, threadId), inArray(schema.runs.status, ["queued", "running"])));
  return rows.length > 0;
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
    if (thread.source !== "workspace" || CLOSED.includes(thread.state))
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
    if (CLOSED.includes(thread.state))
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

/** A dashboard message is an inbox event; a busy thread keeps its current run. */
export async function postChatMessage(
  deps: { db: Db; queues: Queues; hub?: Notifier },
  actor: { userId: string; name: string },
  threadId: string,
  rawText: unknown,
): Promise<{ eventId: string; runId: string | null; interjected: false } | ServiceFailure> {
  const [thread] = await deps.db.select().from(schema.threads)
    .where(eq(schema.threads.id, threadId));
  if (!thread || thread.userId !== actor.userId)
    return { error: "thread not found", status: 404 };
  if (isTerminal(thread.state))
    return { error: `thread is ${thread.state} — it takes no more turns`, status: 409 };

  const text = typeof rawText === "string" ? rawText.trim() : "";
  if (!text) return { error: "empty message", status: 400 };
  if (text.length > 8000) return { error: "message too long (8000 characters max)", status: 400 };

  const evt = await appendEvent(deps.db, {
    threadId: thread.id,
    kind: "chat_message",
    payload: { body: text, author: actor.name, via: "dashboard" },
  });

  // Dashboard messages QUEUE. A busy thread keeps its current run — sending is
  // never an implicit cancellation; interjection stays a separate action.
  const active = await latestActiveRun(deps.db, thread.id);
  let runId: string | null = active?.id ?? null;
  if (!active) {
    const run = await drainInbox({ db: deps.db, queues: deps.queues }, thread.id);
    runId = run?.id ?? null;
  }
  deps.hub?.notify(thread.id);
  return { eventId: String(evt.id), runId, interjected: false };
}
