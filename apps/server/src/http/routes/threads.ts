/**
 * Thread reads and the conversation surface: list, detail, trace, export,
 * messages, SSE. Queries live in `services/threads`; this module only gates
 * access and shapes responses.
 */
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { isFailure, postChatMessage } from "../../services/threads/commands.js";
import {
  threadDetailData,
  threadListData,
  threadTraceData,
  threadTraceExportData,
} from "../../services/threads/queries.js";
import { runSummary, threadSummary, type ApiContext } from "../context.js";

export function createThreadRoutes(ctx: ApiContext) {
  const { deps } = ctx;
  const app = new Hono();

  app.get("/api/threads", async (c) => {
    const user = await ctx.requireUser(c);
    if (!ctx.ok(user)) return user;

    const { threads, latest, pendingCount } = await threadListData(deps.db, user.id);
    return c.json({
      threads: threads.map((t) => ({
        ...threadSummary(t),
        pendingEvents: pendingCount.get(t.id) ?? 0,
        latestRun: latest.has(t.id) ? runSummary(latest.get(t.id)!) : null,
      })),
    });
  });

  app.get("/api/threads/:id", async (c) => {
    const user = await ctx.requireUser(c);
    if (!ctx.ok(user)) return user;
    const thread = await ctx.loadThread(c.req.param("id"));
    if (!thread || !ctx.threadVisibleTo(thread, user.id))
      return c.json({ error: "thread not found" }, 404);

    const data = await threadDetailData(deps.db, thread);

    return c.json({
      thread: {
        ...threadSummary(thread),
        installationAccount: data.installationAccount,
        issueUrl:
          thread.source === "github"
            ? `https://github.com/${thread.repo}/issues/${thread.issueNumber}`
            : null,
      },
      runs: data.runs.map((r) => ({
        ...runSummary(r),
        agentText:
          data.conversations
            .get(r.id)
            ?.parts.filter((p) => p.kind === "text" && p.text?.trim())
            .at(-1)?.text ?? null,
        conversation: data.conversations.get(r.id),
      })),
      events: data.events.map((e) => ({
        id: String(e.id),
        kind: e.kind,
        payload: e.payload,
        status: e.status,
        receivedAt: e.receivedAt,
        consumedAt: e.consumedAt,
      })),
      questions: data.questions,
      pendingEvents: data.pendingEvents.map((e) => ({
        id: String(e.id),
        kind: e.kind,
        payload: e.payload,
        receivedAt: e.receivedAt,
      })),
    });
  });

  // The whole-thread trace: every run + its spans in one payload. Token deltas
  // are excluded and heavy tool output is trimmed for transport.
  app.get("/api/threads/:id/trace", async (c) => {
    const user = await ctx.requireUser(c);
    if (!ctx.ok(user)) return user;
    const thread = await ctx.loadThread(c.req.param("id"));
    if (!thread || !ctx.threadVisibleTo(thread, user.id))
      return c.json({ error: "thread not found" }, 404);

    const { runs, spans } = await threadTraceData(deps.db, thread);
    const finishedRuns = runs.filter((r) => r.finishedAt);

    return c.json({
      thread: threadSummary(thread),
      totals: {
        runs: runs.length,
        codingRuns: runs.filter((r) => r.agent !== "chat").length,
        chatRuns: runs.filter((r) => r.agent === "chat").length,
        tokensIn: runs.reduce((n, r) => n + r.tokensIn, 0),
        tokensOut: runs.reduce((n, r) => n + r.tokensOut, 0),
        usd: runs.reduce((n, r) => n + Number(r.usd), 0).toFixed(4),
        startedAt: runs.find((r) => r.startedAt)?.startedAt ?? runs[0]?.createdAt ?? null,
        finishedAt: finishedRuns.length ? finishedRuns[finishedRuns.length - 1]!.finishedAt : null,
      },
      runs: runs.map((r) => ({
        ...runSummary(r),
        steps: r.steps,
        tokensIn: r.tokensIn,
        tokensOut: r.tokensOut,
        usd: r.usd,
        keepSandbox: r.keepSandbox,
        startedAt: r.startedAt,
        finishedAt: r.finishedAt,
      })),
      spans,
    });
  });

  // The journal exactly as recorded — exports trim nothing.
  app.get("/api/threads/:id/trace/export", async (c) => {
    const user = await ctx.requireUser(c);
    if (!ctx.ok(user)) return user;
    const thread = await ctx.loadThread(c.req.param("id"));
    if (!thread || !ctx.threadVisibleTo(thread, user.id))
      return c.json({ error: "thread not found" }, 404);

    const { runs, spans } = await threadTraceExportData(deps.db, thread);
    c.header("content-disposition", `attachment; filename="trace-${thread.id}.json"`);
    return c.json({
      exportedAt: new Date().toISOString(),
      thread: threadSummary(thread),
      runs: runs.map((r) => ({
        ...runSummary(r),
        steps: r.steps,
        tokensIn: r.tokensIn,
        tokensOut: r.tokensOut,
        usd: r.usd,
        keepSandbox: r.keepSandbox,
        startedAt: r.startedAt,
        finishedAt: r.finishedAt,
      })),
      spans: spans.map((e) => ({
        id: String(e.id),
        runId: e.runId,
        seq: e.seq,
        type: e.type,
        payload: e.payload,
        ts: e.ts,
      })),
    });
  });

  app.post("/api/threads/:id/messages", async (c) => {
    const user = await ctx.requireUser(c);
    if (!ctx.ok(user)) return user;
    const body = (await c.req.json().catch(() => ({}))) as { text?: unknown };
    const result = await postChatMessage(
      { db: deps.db, queues: deps.queues, ...(deps.hub ? { hub: deps.hub } : {}) },
      { userId: user.id, name: user.login ?? user.name ?? user.email ?? "you" },
      c.req.param("id"),
      body.text,
    );
    if (isFailure(result)) return c.json({ error: result.error }, result.status);
    return c.json({ ok: true, ...result });
  });

  // SSE nudges only — the client refetches; Postgres is the truth.
  app.get("/api/threads/:id/stream", async (c) => {
    const user = await ctx.requireUser(c);
    if (!ctx.ok(user)) return user;
    const thread = await ctx.loadThread(c.req.param("id"));
    if (!thread || !ctx.threadVisibleTo(thread, user.id))
      return c.json({ error: "thread not found" }, 404);
    const threadId = thread.id;
    c.header("Cache-Control", "no-cache, no-transform");
    c.header("X-Accel-Buffering", "no");

    return streamSSE(c, async (stream) => {
      const unregister = deps.hub.register(threadId, (line) => {
        stream.write(line).catch(() => undefined);
      });
      stream.onAbort(unregister);
      try {
        await stream.write(`event: hello\ndata: ${JSON.stringify({ threadId })}\n\n`).catch(() => undefined);
        while (!stream.aborted) {
          await stream.sleep(15_000); // keepalive cadence
          if (stream.aborted) break;
          await stream.write(": keepalive\n\n").catch(() => undefined);
        }
      } finally {
        unregister();
      }
    });
  });

  return app;
}
