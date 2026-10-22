/** Answering an agent's question batch, atomically. */
import { and, eq, inArray } from "drizzle-orm";
import { schema, type Db } from "../../db/index.js";
import { RUN_JOB_OPTIONS, type Queues } from "../../queue/index.js";
import { enabledRepositories } from "./repositories.js";
import { validateAnswers, type Question } from "./questions.js";
import { CLOSED_STATES, type Notifier, type ServiceFailure } from "./result.js";

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
  if (CLOSED_STATES.includes(thread.state)) return { error: "Thread is closed.", status: 409 };

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
