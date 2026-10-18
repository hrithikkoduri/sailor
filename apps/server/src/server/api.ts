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
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNull,
  notInArray,
  or,
} from "drizzle-orm";
import { projectConversation } from "../chat/projection.js";
import { schema, type Db } from "../db/index.js";
import type { User } from "../db/schema.js";
import type { Queues } from "../queue/index.js";
import type { UserFromRequest } from "../auth/routes.js";
import { requestCancel } from "../runs/lease.js";
import { appendEvent, drainInbox, pendingEvents } from "../threads/inbox.js";
import { isTerminal } from "../threads/state.js";
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
  agent: r.agent,
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
  const ok = (value: User | Response): value is User =>
    !(value instanceof Response);

  /** v1 visibility: owned threads + installation-less (local/dev) threads. */
  const visibleWhere = (userId: string) =>
    or(
      eq(schema.threads.userId, userId),
      isNull(schema.threads.installationId),
    );

  const threadVisibleTo = (
    thread: Pick<ThreadRow, "userId" | "installationId">,
    userId: string,
  ) => thread.userId === userId || thread.installationId === null;

  const loadThread = async (threadId: string) => {
    const [thread] = await deps.db
      .select()
      .from(schema.threads)
      .where(eq(schema.threads.id, threadId));
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
          .where(
            and(
              inArray(schema.events.threadId, ids),
              eq(schema.events.status, "pending"),
            ),
          )
      : [];

    const latest = new Map<string, RunRow>();
    for (const r of runs)
      if (!latest.has(r.threadId)) latest.set(r.threadId, r);
    const pendingCount = new Map<string, number>();
    for (const p of pending) {
      if (p.threadId)
        pendingCount.set(p.threadId, (pendingCount.get(p.threadId) ?? 0) + 1);
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
    if (!thread || !threadVisibleTo(thread, user.id))
      return c.json({ error: "thread not found" }, 404);

    const runs = await deps.db
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.threadId, thread.id))
      .orderBy(desc(schema.runs.createdAt));
    const pending = await pendingEvents(deps.db, thread.id);
    const eventRows = await deps.db
      .select()
      .from(schema.events)
      .where(eq(schema.events.threadId, thread.id))
      .orderBy(asc(schema.events.id))
      .limit(200);
    const [installation] =
      thread.installationId != null
        ? await deps.db
            .select({ accountLogin: schema.installations.accountLogin })
            .from(schema.installations)
            .where(
              eq(schema.installations.installationId, thread.installationId),
            )
        : [];

    // Finished calls carry full text; only active runs need individual deltas
    // for refresh-mid-stream hydration. One query, not one query per turn.
    const runIds = runs.map((r) => r.id);
    const activeIds = runs
      .filter((r) => ["queued", "running"].includes(r.status))
      .map((r) => r.id);
    const nonDelta = notInArray(schema.traceEvents.type, [
      "llm_text_delta",
      "llm_reasoning_delta",
    ]);
    const journal = runIds.length
      ? await deps.db
          .select({
            runId: schema.traceEvents.runId,
            seq: schema.traceEvents.seq,
            type: schema.traceEvents.type,
            payload: schema.traceEvents.payload,
          })
          .from(schema.traceEvents)
          .where(
            and(
              inArray(schema.traceEvents.runId, runIds),
              activeIds.length
                ? or(nonDelta, inArray(schema.traceEvents.runId, activeIds))
                : nonDelta,
            ),
          )
          .orderBy(asc(schema.traceEvents.seq))
      : [];
    const conversations = new Map(
      runs.map((run) => [
        run.id,
        projectConversation(
          journal.filter((row) => row.runId === run.id),
          run.status,
        ),
      ]),
    );

    return c.json({
      thread: {
        ...threadSummary(thread),
        installationAccount: installation?.accountLogin ?? null,
        issueUrl:
          thread.source === "github"
            ? `https://github.com/${thread.repo}/issues/${thread.issueNumber}`
            : null,
      },
      runs: runs.map((r) => ({
        ...runSummary(r),
        agentText:
          conversations
            .get(r.id)
            ?.parts.filter((p) => p.kind === "text" && p.text?.trim())
            .at(-1)?.text ?? null,
        conversation: conversations.get(r.id),
      })),
      events: eventRows.map((e) => ({
        id: String(e.id),
        kind: e.kind,
        payload: e.payload,
        status: e.status,
        receivedAt: e.receivedAt,
        consumedAt: e.consumedAt,
      })),
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
    const [run] = await deps.db
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.id, c.req.param("id")));
    if (!run) return c.json({ error: "run not found" }, 404);
    const thread = await loadThread(run.threadId);
    if (!thread || !threadVisibleTo(thread, user.id))
      return c.json({ error: "run not found" }, 404);

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
      trace: trace.map((e) => ({
        id: String(e.id),
        seq: e.seq,
        type: e.type,
        payload: e.payload,
        ts: e.ts,
      })),
    });
  });

  // The whole-thread trace: every run + its spans in one payload — the
  // dashboard's explorer renders this as ONE tree (LangSmith-style, by
  // request). Token deltas are excluded (reconstructable from
  // llm_call_finished and they'd dominate the payload); heavy tool output is
  // trimmed for transport. Thread-level aggregates ride along in `totals`.
  app.get("/api/threads/:id/trace", async (c) => {
    const user = await requireUser(c);
    if (!ok(user)) return user;
    const thread = await loadThread(c.req.param("id"));
    if (!thread || !threadVisibleTo(thread, user.id))
      return c.json({ error: "thread not found" }, 404);

    const runs = await deps.db
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.threadId, thread.id))
      .orderBy(asc(schema.runs.createdAt));
    const runIds = runs.map((r) => r.id);
    const rows = runIds.length
      ? await deps.db
          .select()
          .from(schema.traceEvents)
          .where(
            and(
              inArray(schema.traceEvents.runId, runIds),
              notInArray(schema.traceEvents.type, [
                "llm_text_delta",
                "llm_reasoning_delta",
              ]),
            ),
          )
          .orderBy(asc(schema.traceEvents.runId), asc(schema.traceEvents.seq))
      : [];

    const spans = rows.map((e) => {
      let payload = e.payload as Record<string, unknown>;
      const content = payload.content;
      if (
        e.type === "tool_result" &&
        typeof content === "string" &&
        content.length > 4000
      ) {
        payload = {
          ...payload,
          content: `${content.slice(0, 4000)}\n… (truncated)`,
        };
      }
      return {
        id: String(e.id),
        runId: e.runId,
        seq: e.seq,
        type: e.type,
        payload,
        ts: e.ts,
      };
    });

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
        startedAt:
          runs.find((r) => r.startedAt)?.startedAt ??
          runs[0]?.createdAt ??
          null,
        finishedAt: finishedRuns.length
          ? finishedRuns[finishedRuns.length - 1]!.finishedAt
          : null,
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

  // --- actions ----------------------------------------------------------------------

  const loadRunForAction = async (runId: string, userId: string) => {
    const [run] = await deps.db
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.id, runId));
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
        .set({
          status: "cancelled",
          finishedAt: new Date(),
          error: "cancelled before start",
        })
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
    await deps.db
      .update(schema.runs)
      .set({ keepSandbox: true })
      .where(eq(schema.runs.id, run.id));
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
    const [event] = await deps.db
      .select()
      .from(schema.events)
      .where(eq(schema.events.id, eventId));
    if (!event?.threadId) return c.json({ error: "event not found" }, 404);
    const thread = await loadThread(event.threadId);
    if (!thread || !threadVisibleTo(thread, user.id))
      return c.json({ error: "event not found" }, 404);
    if (event.status !== "pending")
      return c.json({ ok: false, reason: `event is ${event.status}` }, 409);

    // The explicit override (decision #28): the pending event forces its way in.
    const [active] = await deps.db
      .select({ id: schema.runs.id, status: schema.runs.status })
      .from(schema.runs)
      .where(
        and(
          eq(schema.runs.threadId, thread.id),
          inArray(schema.runs.status, ["queued", "running"]),
        ),
      )
      .orderBy(desc(schema.runs.createdAt))
      .limit(1);

    if (active?.status === "running") {
      await requestCancel(deps.db, active.id);
      hub.notify(thread.id);
      log(
        `api: interject on thread ${thread.id} — cancel requested on run ${active.id}`,
      );
      return c.json({ ok: true, action: "interjected", runId: active.id });
    }
    if (active?.status === "queued") {
      // The turn is already scheduled; this event will be its input (or the
      // next drain's). Nothing to force.
      return c.json({
        ok: true,
        action: "already-scheduled",
        runId: active.id,
      });
    }

    // Idle thread with a pending event: run it now instead of waiting.
    const run = await drainInbox(
      { db: deps.db, queues: deps.queues },
      thread.id,
    );
    hub.notify(thread.id);
    log(
      `api: interject on idle thread ${thread.id} → ${run ? `run ${run.id} queued` : "no-op"}`,
    );
    return c.json({
      ok: true,
      action: run ? "woken" : "no-op",
      runId: run?.id ?? null,
    });
  });

  // --- chat (step 18): a dashboard message is an inbox event like any other ---

  app.post("/api/threads/:id/messages", async (c) => {
    const user = await requireUser(c);
    if (!ok(user)) return user;
    const thread = await loadThread(c.req.param("id"));
    if (!thread || !threadVisibleTo(thread, user.id))
      return c.json({ error: "thread not found" }, 404);
    if (isTerminal(thread.state)) {
      return c.json(
        { error: `thread is ${thread.state} — it takes no more turns` },
        409,
      );
    }

    const body = (await c.req.json().catch(() => ({}))) as { text?: unknown };
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!text) return c.json({ error: "empty message" }, 400);
    if (text.length > 8000)
      return c.json({ error: "message too long (8000 characters max)" }, 400);

    const author = user.login ?? user.name ?? user.email ?? "you";
    const evt = await appendEvent(deps.db, {
      threadId: thread.id,
      kind: "chat_message",
      payload: { body: text, author, via: "dashboard" },
    });

    // Dashboard messages QUEUE. A busy thread keeps its current run — sending
    // is never an implicit cancellation. Interjection stays a separate,
    // explicit action (double-Enter / the composer chip →
    // POST /api/events/:id/interject); when a run finishes the worker drains
    // pending events into the next turn.
    const [active] = await deps.db
      .select({ id: schema.runs.id, status: schema.runs.status })
      .from(schema.runs)
      .where(
        and(
          eq(schema.runs.threadId, thread.id),
          inArray(schema.runs.status, ["queued", "running"]),
        ),
      )
      .orderBy(desc(schema.runs.createdAt))
      .limit(1);

    let runId: string | null = active?.id ?? null;
    if (active?.status === "running" || active?.status === "queued") {
      log(
        `api: chat message on thread ${thread.id} — queued behind run ${active.id}`,
      );
    } else {
      const run = await drainInbox(
        { db: deps.db, queues: deps.queues },
        thread.id,
      );
      runId = run?.id ?? null;
      log(
        `api: chat message on idle thread ${thread.id} → ${run ? `run ${run.id} queued` : "no-op"}`,
      );
    }

    hub.notify(thread.id);
    return c.json({
      ok: true,
      eventId: String(evt.id),
      interjected: false,
      runId,
    });
  });

  // --- SSE (nudges only — the client refetches) --------------------------------------

  app.get("/api/threads/:id/stream", async (c) => {
    const user = await requireUser(c);
    if (!ok(user)) return user;
    const thread = await loadThread(c.req.param("id"));
    if (!thread || !threadVisibleTo(thread, user.id))
      return c.json({ error: "thread not found" }, 404);
    const threadId = thread.id;
    c.header("Cache-Control", "no-cache, no-transform");
    c.header("X-Accel-Buffering", "no");

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
