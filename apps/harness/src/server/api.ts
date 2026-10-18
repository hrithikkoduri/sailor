/**
 * api.ts — the dashboard's REST + SSE surface (BUILD_PLAN step 17b).
 *
 * Everything the React app reads: threads, runs, traces, pending events — and
 * the four small actions:
 *   cancel a run        (durable request — the worker aborts at a turn boundary)
 *   keep its sandbox    (debugging switch the executor honors at run end)
 *   interject an event  (decision #28's explicit override: a pending event
 *                        forces the active run to stop and become the next turn)
 *   stream              (SSE nudges; the client refetches — stream.ts)
 *
 * Visibility (v1, single-tenant-ish): threads the user owns, plus local/dev
 * threads with no installation behind them. Real multi-tenant scoping arrives
 * with the public launch.
 */
import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { and, asc, desc, eq, inArray, isNull, or } from "drizzle-orm";
import { schema, type Db } from "../db/index.js";
import type { User } from "../db/schema.js";
import type { Queues } from "../queue/index.js";
import type { UserFromRequest } from "../auth/routes.js";
import { requestCancel } from "../runs/lease.js";
import { drainInbox, pendingEvents } from "../threads/inbox.js";
import { createStreamHub, type StreamHub } from "./stream.js";

export interface ApiDeps {
  db: Db;
  queues: Queues;
  getUser: UserFromRequest;
  /** Shared with the server app; defaults to a fresh hub (tests). */
  hub?: StreamHub;
  log?: (line: string) => void;
}

type RunRow = typeof schema.runs.$inferSelect;
type ThreadRow = typeof schema.threads.$inferSelect;

const runSummary = (r: RunRow) => ({
  id: r.id,
  status: r.status,
  trigger: r.trigger,
  phase: r.phase,
  disposition: r.disposition,
  error: r.error,
  task: r.task,
  startedAt: r.startedAt,
  finishedAt: r.finishedAt,
  createdAt: r.createdAt,
});

const threadSummary = (t: ThreadRow) => ({
  id: t.id,
  repo: t.repo,
  issueNumber: t.issueNumber,
  state: t.state,
  source: t.source,
  prNumber: t.prNumber,
  prUrl: t.prUrl,
  headRef: t.headRef,
  baseRef: t.baseRef,
  phase: t.phase,
  summary: t.summary,
  turnsUsed: t.turnsUsed,
  budgetMaxTurns: t.budgetMaxTurns,
  usdSpent: t.usdSpent,
  budgetMaxUsd: t.budgetMaxUsd,
  checkpointSha: t.checkpointSha,
  watch: t.watch,
  createdAt: t.createdAt,
  updatedAt: t.updatedAt,
});

export function createApiRoutes(deps: ApiDeps): Hono {
  const hub = deps.hub ?? createStreamHub();
  const log = deps.log ?? (() => undefined);
  const app = new Hono();

  /** Auth gate — returns the user or a 401 Response. */
  const requireUser = async (c: Context): Promise<User | Response> => {
    const user = await deps.getUser(c);
    return user ?? c.json({ error: "unauthorized" }, 401);
  };
  const ok = (value: User | Response): value is User => !(value instanceof Response);

  /** v1 visibility: owned threads + installation-less (local/dev) threads. */
  const visibleWhere = (userId: string) =>
    or(eq(schema.threads.userId, userId), isNull(schema.threads.installationId));

  const threadVisibleTo = (thread: Pick<ThreadRow, "userId" | "installationId">, userId: string) =>
    thread.userId === userId || thread.installationId === null;

  const loadThread = async (threadId: string) => {
    const [thread] = await deps.db.select().from(schema.threads).where(eq(schema.threads.id, threadId));
    return thread;
  };

  // --- list ---------------------------------------------------------------------

  app.get("/api/threads", async (c) => {
    const user = await requireUser(c);
    if (!ok(user)) return user;

    const threads = await deps.db
      .select()
      .from(schema.threads)
      .where(visibleWhere(user.id))
      .orderBy(desc(schema.threads.updatedAt))
      .limit(100);
    const ids = threads.map((t) => t.id);
    const runs = ids.length
      ? await deps.db
          .select()
          .from(schema.runs)
          .where(inArray(schema.runs.threadId, ids))
          .orderBy(desc(schema.runs.createdAt))
      : [];
    const pending = ids.length
      ? await deps.db
          .select({ threadId: schema.events.threadId })
          .from(schema.events)
          .where(and(inArray(schema.events.threadId, ids), eq(schema.events.status, "pending")))
      : [];

    const latest = new Map<string, RunRow>();
    for (const r of runs) if (!latest.has(r.threadId)) latest.set(r.threadId, r);
    const pendingCount = new Map<string, number>();
    for (const p of pending) {
      if (p.threadId) pendingCount.set(p.threadId, (pendingCount.get(p.threadId) ?? 0) + 1);
    }

    return c.json({
      threads: threads.map((t) => ({
        ...threadSummary(t),
        pendingEvents: pendingCount.get(t.id) ?? 0,
        latestRun: latest.has(t.id) ? runSummary(latest.get(t.id)!) : null,
      })),
    });
  });

  // --- thread detail (runs + pending events) --------------------------------------

  app.get("/api/threads/:id", async (c) => {
    const user = await requireUser(c);
    if (!ok(user)) return user;
    const thread = await loadThread(c.req.param("id"));
    if (!thread || !threadVisibleTo(thread, user.id)) return c.json({ error: "thread not found" }, 404);

    const runs = await deps.db
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.threadId, thread.id))
      .orderBy(desc(schema.runs.createdAt));
    const pending = await pendingEvents(deps.db, thread.id);
    const [installation] =
      thread.installationId != null
        ? await deps.db
            .select({ accountLogin: schema.installations.accountLogin })
            .from(schema.installations)
            .where(eq(schema.installations.installationId, thread.installationId))
        : [];

    return c.json({
      thread: {
        ...threadSummary(thread),
        installationAccount: installation?.accountLogin ?? null,
        issueUrl: thread.source === "github" ? `https://github.com/${thread.repo}/issues/${thread.issueNumber}` : null,
      },
      runs: runs.map(runSummary),
      pendingEvents: pending.map((e) => ({
        id: String(e.id),
        kind: e.kind,
        payload: e.payload,
        receivedAt: e.receivedAt,
      })),
    });
  });

  // --- run + trace -----------------------------------------------------------------

  app.get("/api/runs/:id", async (c) => {
    const user = await requireUser(c);
    if (!ok(user)) return user;
    const [run] = await deps.db.select().from(schema.runs).where(eq(schema.runs.id, c.req.param("id")));
    if (!run) return c.json({ error: "run not found" }, 404);
    const thread = await loadThread(run.threadId);
    if (!thread || !threadVisibleTo(thread, user.id)) return c.json({ error: "run not found" }, 404);

    const trace = await deps.db
      .select()
      .from(schema.traceEvents)
      .where(eq(schema.traceEvents.runId, run.id))
      .orderBy(asc(schema.traceEvents.seq));

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
      trace: trace.map((e) => ({ id: String(e.id), seq: e.seq, type: e.type, payload: e.payload, ts: e.ts })),
    });
  });

  // --- actions ----------------------------------------------------------------------

  const loadRunForAction = async (runId: string, userId: string) => {
    const [run] = await deps.db.select().from(schema.runs).where(eq(schema.runs.id, runId));
    if (!run) return undefined;
    const thread = await loadThread(run.threadId);
    if (!thread || !threadVisibleTo(thread, userId)) return undefined;
    return run;
  };

  app.post("/api/runs/:id/cancel", async (c) => {
    const user = await requireUser(c);
    if (!ok(user)) return user;
    const run = await loadRunForAction(c.req.param("id"), user.id);
    if (!run) return c.json({ error: "run not found" }, 404);

    if (run.status === "running") {
      // Durable flag (decision #25): the worker's watcher aborts at a turn
      // boundary; the drain then resumes the pending batch at its phase.
      await requestCancel(deps.db, run.id);
      hub.notify(run.threadId);
      log(`api: cancel requested for run ${run.id}`);
      return c.json({ ok: true, action: "cancel-requested" });
    }
    if (run.status === "queued") {
      await deps.db
        .update(schema.runs)
        .set({ status: "cancelled", finishedAt: new Date(), error: "cancelled before start" })
        .where(eq(schema.runs.id, run.id));
      hub.notify(run.threadId);
      log(`api: queued run ${run.id} cancelled`);
      return c.json({ ok: true, action: "cancelled-queued" });
    }
    return c.json({ ok: false, reason: `run is ${run.status}` }, 409);
  });

  app.post("/api/runs/:id/keep-sandbox", async (c) => {
    const user = await requireUser(c);
    if (!ok(user)) return user;
    const run = await loadRunForAction(c.req.param("id"), user.id);
    if (!run) return c.json({ error: "run not found" }, 404);

    // Allowed before or during the run: the executor re-reads the flag right
    // before destruction, so flipping it while running wins the race.
    await deps.db.update(schema.runs).set({ keepSandbox: true }).where(eq(schema.runs.id, run.id));
    hub.notify(run.threadId);
    log(`api: run ${run.id} sandbox will be kept`);
    return c.json({ ok: true, action: "keep-sandbox" });
  });

  app.post("/api/events/:id/interject", async (c) => {
    const user = await requireUser(c);
    if (!ok(user)) return user;

    let eventId: bigint;
    try {
      eventId = BigInt(c.req.param("id"));
    } catch {
      return c.json({ error: "bad event id" }, 400);
    }
    const [event] = await deps.db.select().from(schema.events).where(eq(schema.events.id, eventId));
    if (!event?.threadId) return c.json({ error: "event not found" }, 404);
    const thread = await loadThread(event.threadId);
    if (!thread || !threadVisibleTo(thread, user.id)) return c.json({ error: "event not found" }, 404);
    if (event.status !== "pending") return c.json({ ok: false, reason: `event is ${event.status}` }, 409);

    // The explicit override (decision #28): the pending event forces its way in.
    const [active] = await deps.db
      .select({ id: schema.runs.id, status: schema.runs.status })
      .from(schema.runs)
      .where(
        and(eq(schema.runs.threadId, thread.id), inArray(schema.runs.status, ["queued", "running"])),
      )
      .orderBy(desc(schema.runs.createdAt))
      .limit(1);

    if (active?.status === "running") {
      await requestCancel(deps.db, active.id);
      hub.notify(thread.id);
      log(`api: interject on thread ${thread.id} — cancel requested on run ${active.id}`);
      return c.json({ ok: true, action: "interjected", runId: active.id });
    }
    if (active?.status === "queued") {
      // The turn is already scheduled; this event will be its input (or the
      // next drain's). Nothing to force.
      return c.json({ ok: true, action: "already-scheduled", runId: active.id });
    }

    // Idle thread with a pending event: run it now instead of waiting.
    const run = await drainInbox({ db: deps.db, queues: deps.queues }, thread.id);
    hub.notify(thread.id);
    log(`api: interject on idle thread ${thread.id} → ${run ? `run ${run.id} queued` : "no-op"}`);
    return c.json({ ok: true, action: run ? "woken" : "no-op", runId: run?.id ?? null });
  });

  // --- SSE (nudges only — the client refetches) --------------------------------------

  app.get("/api/threads/:id/stream", async (c) => {
    const user = await requireUser(c);
    if (!ok(user)) return user;
    const thread = await loadThread(c.req.param("id"));
    if (!thread || !threadVisibleTo(thread, user.id)) return c.json({ error: "thread not found" }, 404);
    const threadId = thread.id;

    return streamSSE(c, async (stream) => {
      const unregister = hub.register(threadId, (line) => {
        stream.write(line).catch(() => undefined);
      });
      stream.onAbort(unregister);
      try {
        await stream
          .write(`event: hello\ndata: ${JSON.stringify({ threadId })}\n\n`)
          .catch(() => undefined);
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
