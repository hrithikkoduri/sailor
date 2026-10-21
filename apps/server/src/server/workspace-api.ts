import { randomInt, randomUUID } from "node:crypto";
import { Hono } from "hono";
import { and, desc, eq, inArray, isNull, or } from "drizzle-orm";
import { schema } from "../db/index.js";
import type { ApiDeps } from "./api.js";
import { RUN_JOB_OPTIONS } from "../queue/index.js";
import { enabledRepositories } from "../threads/repositories.js";
import { validateAnswers, type Question } from "../threads/questions.js";
import { releaseThreadSandbox } from "../runs/execute.js";
import { deleteSecret, listSecrets, putSecret } from "../secrets/store.js";

export function createWorkspaceRoutes(deps: ApiDeps) {
  const app = new Hono();
  app.patch("/api/threads/:id", async (c) => {
    const user = await deps.getUser(c);
    if (!user) return c.json({ error: "unauthorized" }, 401);
    const body = await c.req.json().catch(() => ({})) as { title?: unknown };
    const title = typeof body.title === "string" ? body.title.trim() : "";
    if (!title || title.length > 160) return c.json({ error: "Use a title between 1 and 160 characters." }, 400);
    const [thread] = await deps.db.update(schema.threads).set({ title, updatedAt: new Date() })
      .where(and(eq(schema.threads.id, c.req.param("id")), eq(schema.threads.userId, user.id))).returning();
    if (!thread) return c.json({ error: "Thread not found." }, 404);
    deps.hub?.notify(thread.id);
    return c.json({ ok: true, title });
  });

  /**
   * Delete a thread and everything that belongs to it.
   *
   * A live run owns the sandbox, so deletion is refused while one is queued or
   * running — the user stops it first, exactly like any other destructive
   * action on work in progress. Events are deleted explicitly (their FK is
   * `set null`, which would otherwise leave orphan rows), and the retained
   * sandbox is released before the rows disappear.
   */
  app.delete("/api/threads/:id", async (c) => {
    const user = await deps.getUser(c);
    if (!user) return c.json({ error: "unauthorized" }, 401);
    const [thread] = await deps.db.select().from(schema.threads)
      .where(and(eq(schema.threads.id, c.req.param("id")), eq(schema.threads.userId, user.id)));
    if (!thread) return c.json({ error: "Thread not found." }, 404);
    const active = await deps.db.select({ id: schema.runs.id }).from(schema.runs)
      .where(and(eq(schema.runs.threadId, thread.id), inArray(schema.runs.status, ["queued", "running"])));
    if (active.length)
      return c.json({ error: "Stop the current run before deleting this thread." }, 409);

    await releaseThreadSandbox(deps.db, thread).catch(() => undefined);
    await deps.db.transaction(async (tx) => {
      await tx.delete(schema.events).where(eq(schema.events.threadId, thread.id));
      await tx.delete(schema.runs).where(eq(schema.runs.threadId, thread.id));
      await tx.delete(schema.threads).where(eq(schema.threads.id, thread.id));
    });
    return c.json({ ok: true });
  });

  app.post("/api/threads/:id/repository", async (c) => {
    const user = await deps.getUser(c);
    if (!user) return c.json({ error: "unauthorized" }, 401);
    const body = await c.req.json().catch(() => ({})) as { repository?: unknown };
    const repo = (await enabledRepositories(deps.db, user.id)).find((r) => r.fullName === body.repository);
    if (!repo) return c.json({ error: "Repository is not enabled for this account." }, 403);
    const result = await deps.db.transaction(async (tx) => {
      const [thread] = await tx.select().from(schema.threads)
        .where(and(eq(schema.threads.id, c.req.param("id")), eq(schema.threads.userId, user.id))).for("update");
      if (!thread) return { error: "Thread not found.", status: 404 as const };
      if (thread.source !== "workspace" || ["merged", "closed", "abandoned"].includes(thread.state))
        return { error: "This thread already has a repository or is closed. Start a new thread to switch repositories.", status: 409 as const };
      const pending = await tx.select({ id: schema.events.id }).from(schema.events).where(and(
        eq(schema.events.threadId, thread.id), eq(schema.events.kind, "repository_attachment"), eq(schema.events.status, "pending"),
      ));
      if (pending.length) return { error: "An attachment is already queued for this thread.", status: 409 as const };
      const questions = await tx.select({ id: schema.questionRequests.id }).from(schema.questionRequests).where(and(
        eq(schema.questionRequests.threadId, thread.id), eq(schema.questionRequests.status, "pending"),
      ));
      if (questions.length) return { error: "Answer the pending questions before attaching a repository.", status: 409 as const };
      const active = await tx.select({ id: schema.runs.id }).from(schema.runs).where(and(eq(schema.runs.threadId, thread.id), inArray(schema.runs.status, ["queued", "running"])));
      const [event] = await tx.insert(schema.events).values({ threadId: thread.id, kind: "repository_attachment",
        payload: { repository: repo.fullName, body: `Use ${repo.fullName} for this thread and continue the original request.`, author: user.login ?? user.name ?? "you" },
        ...(!active.length ? { status: "consumed", consumedAt: new Date() } : {}),
      }).returning();
      if (active.length) return { queued: true as const, runId: null };
      const [run] = await tx.insert(schema.runs).values({ threadId: thread.id, trigger: "repository_attachment", agent: "coding",
        repoAttachment: repo.fullName, task: `The user attached ${repo.fullName}. Continue the original request in that repository.`,
      }).returning();
      return { queued: false as const, runId: run!.id };
    });
    if ("error" in result) return c.json({ error: result.error }, result.status);
    if (result.runId) await deps.queues.runs.add("run", { runId: result.runId }, RUN_JOB_OPTIONS);
    deps.hub?.notify(c.req.param("id"));
    return c.json({ ok: true, queued: result.queued, runId: result.runId });
  });
  /**
   * Move an existing thread to a different repository.
   *
   * Unlike `/repository` (workspace threads only), this is an explicit switch:
   * the retained sandbox belongs to the old repository and is released, the
   * PR/branch/checkpoint pointers are reset, and the next run starts from a
   * fresh checkout of the new repository. Work already pushed to the old
   * repository stays there — Sailor only moves the thread forward.
   */
  app.post("/api/threads/:id/repository/switch", async (c) => {
    const user = await deps.getUser(c);
    if (!user) return c.json({ error: "unauthorized" }, 401);
    const body = await c.req.json().catch(() => ({})) as { repository?: unknown };
    const repo = (await enabledRepositories(deps.db, user.id)).find(
      (r) => r.fullName === body.repository,
    );
    if (!repo) return c.json({ error: "Repository is not enabled for this account." }, 403);

    const result = await deps.db.transaction(async (tx) => {
      const [thread] = await tx.select().from(schema.threads)
        .where(and(eq(schema.threads.id, c.req.param("id")), eq(schema.threads.userId, user.id)))
        .for("update");
      if (!thread) return { error: "Thread not found.", status: 404 as const };
      if (["merged", "closed", "abandoned"].includes(thread.state))
        return { error: "This thread is closed.", status: 409 as const };
      if (thread.repo === repo.fullName && thread.source === "manual")
        return { error: "This thread already works in that repository.", status: 409 as const };
      const active = await tx.select({ id: schema.runs.id }).from(schema.runs)
        .where(and(eq(schema.runs.threadId, thread.id), inArray(schema.runs.status, ["queued", "running"])));
      if (active.length) return { error: "Wait for the current run to finish before switching repositories.", status: 409 as const };
      const questions = await tx.select({ id: schema.questionRequests.id }).from(schema.questionRequests)
        .where(and(eq(schema.questionRequests.threadId, thread.id), eq(schema.questionRequests.status, "pending")));
      if (questions.length) return { error: "Answer the pending questions before switching repositories.", status: 409 as const };

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
          author: user.login ?? user.name ?? "you",
        },
        status: "consumed", consumedAt: new Date(),
      });
      const [run] = await tx.insert(schema.runs).values({
        threadId: thread.id, trigger: "repository_attachment", agent: "coding",
        repoAttachment: repo.fullName,
        task: `The user switched this thread to ${repo.fullName}. Continue the original request in that repository.`,
      }).returning();
      return { queued: false as const, runId: run!.id, previous: thread };
    });
    if ("error" in result) return c.json({ error: result.error }, result.status);
    // The retained sandbox holds the OLD repository; release it before the new
    // run boots so the next checkout cannot see the previous work.
    await releaseThreadSandbox(deps.db, result.previous).catch(() => undefined);
    await deps.queues.runs.add("run", { runId: result.runId }, RUN_JOB_OPTIONS);
    deps.hub?.notify(c.req.param("id"));
    return c.json({ ok: true, runId: result.runId });
  });

  // --- account secrets (write-only) -------------------------------------------
  // The value is accepted here and never returned anywhere: responses carry
  // metadata only, and the plaintext is decrypted server-side at tool time.
  app.get("/api/secrets", async (c) => {
    const user = await deps.getUser(c);
    if (!user) return c.json({ error: "unauthorized" }, 401);
    return c.json({ secrets: await listSecrets(deps.db, user.id) });
  });

  app.post("/api/secrets", async (c) => {
    const user = await deps.getUser(c);
    if (!user) return c.json({ error: "unauthorized" }, 401);
    const body = (await c.req.json().catch(() => ({}))) as {
      name?: unknown; envVar?: unknown; value?: unknown;
    };
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const envVar = typeof body.envVar === "string" ? body.envVar.trim() : "";
    const value = typeof body.value === "string" ? body.value : "";
    if (!/^[a-z][a-z0-9_-]{0,39}$/.test(name))
      return c.json({ error: "Use a short name like daytona (lowercase letters, digits, - or _)." }, 400);
    if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(envVar))
      return c.json({ error: "Use an environment variable name like DAYTONA_API_KEY." }, 400);
    if (!value.trim() || value.length > 8192)
      return c.json({ error: "A secret value is required (8192 characters max)." }, 400);
    try {
      const secret = await putSecret(deps.db, user.id, { name, envVar, value });
      return c.json({ secret }, 201);
    } catch (err) {
      // Never echo the value; the message only covers key/config problems.
      return c.json({ error: err instanceof Error ? err.message : "Could not store the secret." }, 500);
    }
  });

  app.delete("/api/secrets/:id", async (c) => {
    const user = await deps.getUser(c);
    if (!user) return c.json({ error: "unauthorized" }, 401);
    const removed = await deleteSecret(deps.db, user.id, c.req.param("id"));
    if (!removed) return c.json({ error: "Secret not found." }, 404);
    return c.json({ ok: true });
  });

  app.post("/api/threads", async (c) => {
    const user = await deps.getUser(c);
    if (!user) return c.json({ error: "unauthorized" }, 401);
    const body = await c.req.json().catch(() => null) as { text?: unknown; repo?: unknown } | null;
    const text = typeof body?.text === "string" ? body.text.trim() : "";
    if (!text || text.length > 8000) return c.json({ error: "Enter an instruction (8000 characters max)." }, 400);
    const repoName = typeof body?.repo === "string" ? body.repo : "";
    const repo = repoName ? (await enabledRepositories(deps.db, user.id)).find((r) => r.fullName === repoName) : undefined;
    if (repoName && !repo) return c.json({ error: "Repository is not enabled for your account." }, 403);
    const id = randomUUID();
    // No synthetic issue is created. The negative number only satisfies the
    // legacy dedup column; source distinguishes these from GitHub issues.
    const created = await deps.db.transaction(async (tx) => {
      const [thread] = await tx.insert(schema.threads).values({
        id, title: text.split("\n")[0]!.slice(0, 160), userId: user.id,
        source: repo ? "manual" : "workspace", repo: repo?.fullName ?? `workspace:${id}`,
        issueNumber: -randomInt(1, 2_000_000_000),
        installationId: repo?.installationId ?? null, baseRef: repo?.defaultBranch ?? "main",
      }).returning();
      const [run] = await tx.insert(schema.runs).values({ threadId: id, trigger: "manual", task: text, agent: "coding" }).returning();
      await tx.insert(schema.events).values({ threadId: id, kind: "chat_message",
        payload: { body: text, author: user.login ?? user.name ?? "you", via: "dashboard" }, status: "consumed", consumedAt: new Date() });
      return { thread: thread!, run: run! };
    });
    await deps.queues.runs.add("run", { runId: created.run.id }, RUN_JOB_OPTIONS);
    deps.hub?.notify(id);
    return c.json({ thread: created.thread, runId: created.run.id }, 201);
  });

  app.get("/api/traces", async (c) => {
    const user = await deps.getUser(c);
    if (!user) return c.json({ error: "unauthorized" }, 401);
    const limit = Math.min(100, Math.max(1, Number(c.req.query("limit")) || 50));
    const pageNumber = Number(c.req.query("page") ?? 0);
    const page = Number.isFinite(pageNumber) ? Math.min(10000, Math.max(0, Math.floor(pageNumber))) : 0;
    const rows = await deps.db.select({
      id: schema.runs.id, threadId: schema.runs.threadId, title: schema.threads.title,
      repo: schema.threads.repo, task: schema.runs.task, status: schema.runs.status,
      steps: schema.runs.steps, tokensIn: schema.runs.tokensIn, tokensOut: schema.runs.tokensOut,
      usd: schema.runs.usd, createdAt: schema.runs.createdAt,
      startedAt: schema.runs.startedAt, finishedAt: schema.runs.finishedAt,
    }).from(schema.runs).innerJoin(schema.threads, eq(schema.runs.threadId, schema.threads.id))
      .where(or(eq(schema.threads.userId, user.id), and(isNull(schema.threads.userId), isNull(schema.threads.installationId))))
      .orderBy(desc(schema.runs.createdAt), desc(schema.runs.id)).limit(limit + 1).offset(page * limit);
    return c.json({ traces: rows.slice(0, limit), hasMore: rows.length > limit, page });
  });

  app.post("/api/questions/:id/answers", async (c) => {
    const user = await deps.getUser(c);
    if (!user) return c.json({ error: "unauthorized" }, 401);
    const [request] = await deps.db.select().from(schema.questionRequests)
      .where(eq(schema.questionRequests.id, c.req.param("id")));
    if (!request) return c.json({ error: "Question not found." }, 404);
    const [thread] = await deps.db.select().from(schema.threads).where(eq(schema.threads.id, request.threadId));
    if (!thread || thread.userId !== user.id) return c.json({ error: "Question not found." }, 404);
    if (["merged", "closed", "abandoned"].includes(thread.state)) return c.json({ error: "Thread is closed." }, 409);
    const questions = request.questions as Question[];
    const body = await c.req.json().catch(() => ({})) as { answers?: unknown };
    let answers: Record<string, string | string[]>;
    try { answers = validateAnswers(questions, body.answers); }
    catch (err) { return c.json({ error: (err as Error).message }, 400); }
    const repositoryQuestion = questions.find((q) => q.type === "repository");
    const selected = repositoryQuestion ? answers[repositoryQuestion.id] : undefined;
    const repo = typeof selected === "string" && selected
      ? (await enabledRepositories(deps.db, user.id)).find((r) => r.fullName === selected) : undefined;
    if (selected && (!repo || thread.source !== "workspace"))
      return c.json({ error: "Repository is no longer available, or one is already attached." }, 409);
    const task = "Answers to your questions:\n\n" + questions.map((q) =>
      `${q.label}\n${Array.isArray(answers[q.id]) ? (answers[q.id] as string[]).join(", ") : answers[q.id] || "(not provided)"}`,
    ).join("\n\n") + "\n\nContinue the original request with these answers.";
    // Row lock + conditional status prevents double submits, including from
    // two tabs. The answers and continuation are persisted atomically.
    const next = await deps.db.transaction(async (tx) => {
      const [locked] = await tx.select().from(schema.threads).where(eq(schema.threads.id, thread.id)).for("update");
      const active = await tx.select({ id: schema.runs.id }).from(schema.runs).where(and(
        eq(schema.runs.threadId, thread.id), inArray(schema.runs.status, ["queued", "running"]),
      ));
      if (!locked || active.length) return null;
      const updated = await tx.update(schema.questionRequests).set({ answers, status: "answered", answeredAt: new Date() })
        .where(and(eq(schema.questionRequests.id, request.id), eq(schema.questionRequests.status, "pending"))).returning();
      if (!updated.length) return null;
      await tx.insert(schema.events).values({ threadId: thread.id, kind: "question_answers",
        payload: { body: task, requestId: request.id, answers, author: user.login ?? user.name ?? "you" },
        status: "consumed", consumedAt: new Date() });
      const [run] = await tx.insert(schema.runs).values({ threadId: thread.id, trigger: "answers", task, agent: "coding",
        ...(repo ? { repoAttachment: repo.fullName } : {}),
      }).returning();
      return run!;
    });
    if (!next) return c.json({ error: "Already answered, or the agent is still pausing. Try again in a moment." }, 409);
    await deps.queues.runs.add("run", { runId: next.id }, RUN_JOB_OPTIONS);
    deps.hub?.notify(thread.id);
    return c.json({ ok: true, runId: next.id });
  });
  return app;
}
