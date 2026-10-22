import { Hono } from "hono";
import type { ApiDeps } from "../context.js";
import { answerQuestions } from "../../services/threads/answers.js";
import { createThreadFromMessage, deleteThread, renameThread } from "../../services/threads/create.js";
import { attachRepository, switchRepository } from "../../services/threads/repository.js";
import { isFailure } from "../../services/threads/result.js";
import { deleteSecret, listSecrets, putSecret } from "../../services/secrets/store.js";
import { listTraces } from "../../services/trace/queries.js";
import { secretCreate } from "@sailor/contracts";

export function createWorkspaceRoutes(deps: ApiDeps) {
  const app = new Hono();
  const serviceDeps = () => ({
    db: deps.db,
    queues: deps.queues,
    ...(deps.hub ? { hub: deps.hub } : {}),
  });

  app.patch("/api/threads/:id", async (c) => {
    const user = await deps.getUser(c);
    if (!user) return c.json({ error: "unauthorized" }, 401);
    const body = await c.req.json().catch(() => ({})) as { title?: unknown };
    const result = await renameThread({ db: deps.db, ...(deps.hub ? { hub: deps.hub } : {}) },
      { userId: user.id }, c.req.param("id"), body.title);
    if (isFailure(result)) return c.json({ error: result.error }, result.status);
    return c.json({ ok: true, title: result.title });
  });

  app.delete("/api/threads/:id", async (c) => {
    const user = await deps.getUser(c);
    if (!user) return c.json({ error: "unauthorized" }, 401);
    const result = await deleteThread({ db: deps.db }, { userId: user.id }, c.req.param("id"));
    if (isFailure(result)) return c.json({ error: result.error }, result.status);
    return c.json({ ok: true });
  });

  app.post("/api/threads/:id/repository", async (c) => {
    const user = await deps.getUser(c);
    if (!user) return c.json({ error: "unauthorized" }, 401);
    const body = await c.req.json().catch(() => ({})) as { repository?: unknown };
    const result = await attachRepository(serviceDeps(),
      { userId: user.id, name: user.login ?? user.name ?? "you" },
      c.req.param("id"), body.repository);
    if (isFailure(result)) return c.json({ error: result.error }, result.status);
    return c.json({ ok: true, queued: result.queued, runId: result.runId });
  });

  app.post("/api/threads/:id/repository/switch", async (c) => {
    const user = await deps.getUser(c);
    if (!user) return c.json({ error: "unauthorized" }, 401);
    const body = await c.req.json().catch(() => ({})) as { repository?: unknown };
    const result = await switchRepository(serviceDeps(),
      { userId: user.id, name: user.login ?? user.name ?? "you" },
      c.req.param("id"), body.repository);
    if (isFailure(result)) return c.json({ error: result.error }, result.status);
    return c.json({ ok: true, runId: result.runId });
  });

  app.post("/api/threads", async (c) => {
    const user = await deps.getUser(c);
    if (!user) return c.json({ error: "unauthorized" }, 401);
    const body = await c.req.json().catch(() => null) as { text?: unknown; repo?: unknown } | null;
    const result = await createThreadFromMessage(serviceDeps(),
      { userId: user.id, name: user.login ?? user.name ?? "you" },
      {
        text: typeof body?.text === "string" ? body.text : "",
        ...(typeof body?.repo === "string" && body.repo ? { repoName: body.repo } : {}),
      });
    if (isFailure(result)) return c.json({ error: result.error }, result.status);
    return c.json({ thread: result.thread, runId: result.runId }, 201);
  });

  app.get("/api/traces", async (c) => {
    const user = await deps.getUser(c);
    if (!user) return c.json({ error: "unauthorized" }, 401);
    const limit = Math.min(100, Math.max(1, Number(c.req.query("limit")) || 50));
    const pageNumber = Number(c.req.query("page") ?? 0);
    const page = Number.isFinite(pageNumber) ? Math.min(10000, Math.max(0, Math.floor(pageNumber))) : 0;
    return c.json(await listTraces(deps.db, user.id, { limit, page }));
  });

  app.post("/api/questions/:id/answers", async (c) => {
    const user = await deps.getUser(c);
    if (!user) return c.json({ error: "unauthorized" }, 401);
    const body = await c.req.json().catch(() => ({})) as { answers?: unknown };
    const result = await answerQuestions(serviceDeps(),
      { userId: user.id, name: user.login ?? user.name ?? "you" },
      c.req.param("id"), body.answers);
    if (isFailure(result)) return c.json({ error: result.error }, result.status);
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
    const parsed = secretCreate.safeParse(body);
    if (!parsed.success)
      return c.json({ error: parsed.error.issues[0]?.message ?? "Invalid secret." }, 400);
    const { name, envVar, value } = parsed.data;
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

  return app;
}
