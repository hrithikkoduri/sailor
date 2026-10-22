/** Run reads and the two run actions: cancel, keep-sandbox. */
import { Hono } from "hono";
import { cancelRun, keepSandbox } from "../../services/runs/commands.js";
import { runDetailData } from "../../services/runs/queries.js";
import { runSummary, type ApiContext } from "../context.js";

export function createRunRoutes(ctx: ApiContext) {
  const { deps } = ctx;
  const app = new Hono();

  app.get("/api/runs/:id", async (c) => {
    const user = await ctx.requireUser(c);
    if (!ctx.ok(user)) return user;
    const { run, trace } = await runDetailData(deps.db, c.req.param("id"));
    if (!run) return c.json({ error: "run not found" }, 404);
    const thread = await ctx.loadThread(run.threadId);
    if (!thread || !ctx.threadVisibleTo(thread, user.id))
      return c.json({ error: "run not found" }, 404);

    return c.json({
      run: {
        ...runSummary(run),
        startPhase: run.startPhase,
        steps: run.steps,
        tokensIn: run.tokensIn,
        tokensOut: run.tokensOut,
        usd: run.usd,
        keepSandbox: run.keepSandbox,
        cancelRequestedAt: run.cancelRequestedAt,
        heartbeatAt: run.heartbeatAt,
      },
      trace: trace.map((e) => ({
        id: String(e.id),
        seq: e.seq,
        type: e.type,
        payload: e.payload,
        ts: e.ts,
      })),
    });
  });

  app.post("/api/runs/:id/cancel", async (c) => {
    const user = await ctx.requireUser(c);
    if (!ctx.ok(user)) return user;
    const run = await ctx.loadRunForAction(c.req.param("id"), user.id);
    if (!run) return c.json({ error: "run not found" }, 404);

    const result = await cancelRun(deps.db, deps.hub, run);
    if ("error" in result) return c.json({ ok: false, reason: result.error }, 409);
    deps.log(`api: run ${run.id} ${result.action}`);
    return c.json({ ok: true, action: result.action });
  });

  app.post("/api/runs/:id/keep-sandbox", async (c) => {
    const user = await ctx.requireUser(c);
    if (!ctx.ok(user)) return user;
    const run = await ctx.loadRunForAction(c.req.param("id"), user.id);
    if (!run) return c.json({ error: "run not found" }, 404);

    await keepSandbox(deps.db, deps.hub, run);
    deps.log(`api: run ${run.id} sandbox will be kept`);
    return c.json({ ok: true, action: "keep-sandbox" });
  });

  return app;
}
