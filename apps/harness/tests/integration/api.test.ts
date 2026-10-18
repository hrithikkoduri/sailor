/**
 * The dashboard API (step 17b): threads list, thread detail, run + trace,
 * the three small actions (cancel / keep-sandbox / interject), and the SSE
 * stream — all behind session auth, against a real Postgres + Redis.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { eq, inArray } from "drizzle-orm";
import type { Pool } from "pg";
import { createDb, createPool, schema, type Db } from "../../src/db/index.js";
import { runMigrations } from "../../src/db/migrate.js";
import { createQueueConnection, createQueues, type Queues } from "../../src/queue/index.js";
import { createServerApp } from "../../src/server/app.js";
import { createStreamHub } from "../../src/server/stream.js";
import { createSession, SESSION_COOKIE } from "../../src/auth/session.js";
import { appendEvent } from "../../src/threads/inbox.js";
import { loadConfig } from "../../src/config.js";

describe("dashboard api", () => {
  let pool: Pool;
  let db: Db;
  let queues: Queues;
  let app: ReturnType<typeof createServerApp>;
  let hub: ReturnType<typeof createStreamHub>;
  let cookie: string;
  let userId: string;
  let otherUserId: string;
  let threadId: string;
  let hiddenThreadId: string;
  let idleThreadId: string;
  let runOkId: string;
  let runLiveId: string;
  let runQueuedId: string;
  let pendingEventId: string;

  const stamp = Date.now();

  beforeAll(async () => {
    pool = createPool(loadConfig().postgres.url);
    db = createDb(pool);
    await runMigrations(db);
    queues = createQueues(createQueueConnection(loadConfig().redis.url));
    hub = createStreamHub();
    app = createServerApp({
      db,
      queues,
      webhookSecret: "test-secret",
      skipSignatureVerification: true,
      hub,
      authConfig: { sessionTtlDays: 30, secureCookies: false, devBypass: false },
      log: () => undefined,
    });

    const [user] = await db.insert(schema.users).values({ email: `api-${stamp}@test.dev` }).returning();
    userId = user!.id;
    const [other] = await db.insert(schema.users).values({ email: `api-other-${stamp}@test.dev` }).returning();
    otherUserId = other!.id;
    cookie = `${SESSION_COOKIE}=${(await createSession(db, userId, 30)).token}`;

    const [thread] = await db
      .insert(schema.threads)
      .values({
        repo: `test/api-${stamp}`,
        issueNumber: 1,
        source: "github",
        state: "pr_open",
        baseRef: "main",
        headRef: `harness/issue-1`,
        prNumber: 11,
        prUrl: `https://github.com/test/api-${stamp}/pull/11`,
        userId,
        turnsUsed: 2,
        phase: "verify",
      })
      .returning();
    threadId = thread!.id;

    // Hidden: another user's thread behind a real installation.
    const [hidden] = await db
      .insert(schema.threads)
      .values({
        repo: `test/api-hidden-${stamp}`,
        issueNumber: 2,
        source: "github",
        state: "queued",
        userId: otherUserId,
        installationId: 777_000 + (stamp % 1000),
      })
      .returning();
    hiddenThreadId = hidden!.id;

    // Owned but idle, with a pending event — the interject-wakes case.
    const [idle] = await db
      .insert(schema.threads)
      .values({ repo: `test/api-idle-${stamp}`, issueNumber: 3, source: "github", state: "queued", userId })
      .returning();
    idleThreadId = idle!.id;
    await appendEvent(db, {
      threadId: idleThreadId,
      kind: "issue_comment",
      payload: { body: "please also handle the edge case", author: "octocat" },
    });

    // Two runs: an older succeeded one (with trace) and a live one.
    const [runOk] = await db
      .insert(schema.runs)
      .values({
        threadId,
        status: "succeeded",
        trigger: "label",
        task: "Fix issue #1",
        phase: "verify",
        disposition: "done",
        steps: 9,
        tokensIn: 1234,
        tokensOut: 567,
        usd: "0.0123",
        startedAt: new Date(stamp - 120_000),
        finishedAt: new Date(stamp - 60_000),
        createdAt: new Date(stamp - 130_000),
      })
      .returning();
    runOkId = runOk!.id;
    await db.insert(schema.traceEvents).values([
      { runId: runOkId, seq: 0, type: "run_started", payload: { type: "run_started", task: "Fix issue #1", phases: ["reproduce", "fix", "verify"] } },
      { runId: runOkId, seq: 1, type: "phase_started", payload: { type: "phase_started", phase: "reproduce" } },
      { runId: runOkId, seq: 2, type: "tool_call", payload: { type: "tool_call", phase: "reproduce", step: 1, name: "run_tests", input: {} } },
      { runId: runOkId, seq: 3, type: "run_finished", payload: { type: "run_finished", ok: true, steps: 9, usage: { promptTokens: 1234, completionTokens: 567 }, reason: "finished", disposition: "done" } },
    ]);

    const [runLive] = await db
      .insert(schema.runs)
      .values({
        threadId,
        status: "running",
        trigger: "inbox",
        task: "Address the review comments",
        phase: "fix",
        startedAt: new Date(stamp - 10_000),
        createdAt: new Date(stamp - 20_000),
      })
      .returning();
    runLiveId = runLive!.id;

    const [runQueued] = await db
      .insert(schema.runs)
      .values({ threadId: idleThreadId, status: "queued", trigger: "label", createdAt: new Date(stamp) })
      .returning();
    runQueuedId = runQueued!.id;

    const events = await db.select().from(schema.events).where(eq(schema.events.threadId, threadId));
    void events;
  });

  afterAll(async () => {
    await db.delete(schema.events).where(inArray(schema.events.threadId, [threadId, hiddenThreadId, idleThreadId]));
    await db.delete(schema.threads).where(inArray(schema.threads.id, [threadId, hiddenThreadId, idleThreadId]));
    await db.delete(schema.users).where(inArray(schema.users.id, [userId, otherUserId]));
    await queues.close();
    await pool.end();
  });

  it("requires a session", async () => {
    expect((await app.request("/api/threads")).status).toBe(401);
    expect((await app.request(`/api/threads/${threadId}`)).status).toBe(401);
  });

  it("lists owned threads with latest run + pending counts, hides other users' threads", async () => {
    const res = await app.request("/api/threads", { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      threads: Array<{ id: string; latestRun: { id: string; status: string } | null; pendingEvents: number }>;
    };
    const ids = body.threads.map((t) => t.id);
    expect(ids).toContain(threadId);
    expect(ids).toContain(idleThreadId);
    expect(ids).not.toContain(hiddenThreadId);

    const mine = body.threads.find((t) => t.id === threadId)!;
    expect(mine.latestRun).toMatchObject({ id: runLiveId, status: "running" });
  });

  it("thread detail: runs newest-first + pending events; hidden thread 404s", async () => {
    const res = await app.request(`/api/threads/${threadId}`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      thread: { id: string; repo: string; turnsUsed: number; prUrl: string };
      runs: Array<{ id: string; status: string }>;
      pendingEvents: unknown[];
    };
    expect(body.thread).toMatchObject({ id: threadId, turnsUsed: 2 });
    expect(body.runs.map((r) => r.id)).toEqual([runLiveId, runOkId]);
    expect(body.pendingEvents).toHaveLength(0);

    expect((await app.request(`/api/threads/${hiddenThreadId}`, { headers: { cookie } })).status).toBe(404);
  });

  it("run detail: full trace in sequence order", async () => {
    const res = await app.request(`/api/runs/${runOkId}`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      run: { id: string; steps: number; tokensIn: number };
      trace: Array<{ seq: number; type: string }>;
    };
    expect(body.run).toMatchObject({ id: runOkId, steps: 9, tokensIn: 1234 });
    expect(body.trace.map((e) => e.seq)).toEqual([0, 1, 2, 3]);
    expect(body.trace.map((e) => e.type)).toEqual(["run_started", "phase_started", "tool_call", "run_finished"]);
  });

  it("cancel: a running run gets the durable flag; a queued run flips to cancelled", async () => {
    const live = await app.request(`/api/runs/${runLiveId}/cancel`, { method: "POST", headers: { cookie } });
    expect(live.status).toBe(200);
    expect(((await live.json()) as { action: string }).action).toBe("cancel-requested");
    const [runLive] = await db.select().from(schema.runs).where(eq(schema.runs.id, runLiveId));
    expect(runLive!.cancelRequestedAt).toBeTruthy();

    const queued = await app.request(`/api/runs/${runQueuedId}/cancel`, { method: "POST", headers: { cookie } });
    expect(queued.status).toBe(200);
    expect(((await queued.json()) as { action: string }).action).toBe("cancelled-queued");
    const [runQueued] = await db.select().from(schema.runs).where(eq(schema.runs.id, runQueuedId));
    expect(runQueued!.status).toBe("cancelled");
    expect(runQueued!.finishedAt).toBeTruthy();
  });

  it("keep-sandbox flips the run flag", async () => {
    const res = await app.request(`/api/runs/${runLiveId}/keep-sandbox`, { method: "POST", headers: { cookie } });
    expect(res.status).toBe(200);
    const [run] = await db.select().from(schema.runs).where(eq(schema.runs.id, runLiveId));
    expect(run!.keepSandbox).toBe(true);
  });

  it("interject: busy run → cancel requested; idle thread → the event wakes a run", async () => {
    // Busy: point the interject at the idle thread's run… first put an active
    // run on the busy thread, then interject the pending event on the idle one.
    const busyEvent = await db
      .insert(schema.events)
      .values({ threadId, kind: "pull_request_review", payload: { author: "octocat", body: "nit: rename this" } })
      .returning();
    pendingEventId = String(busyEvent[0]!.id);

    const busy = await app.request(`/api/events/${pendingEventId}/interject`, { method: "POST", headers: { cookie } });
    expect(busy.status).toBe(200);
    expect(((await busy.json()) as { action: string }).action).toBe("interjected");

    const [liveRun] = await db.select().from(schema.runs).where(eq(schema.runs.id, runLiveId));
    expect(liveRun!.cancelRequestedAt).toBeTruthy();

    // Idle: the pending event on the idle thread wakes a run right now.
    const [pending] = await db
      .select()
      .from(schema.events)
      .where(eq(schema.events.threadId, idleThreadId));
    const idle = await app.request(`/api/events/${String(pending!.id)}/interject`, {
      method: "POST",
      headers: { cookie },
    });
    expect(idle.status).toBe(200);
    const idleBody = (await idle.json()) as { action: string; runId: string | null };
    expect(idleBody.action).toBe("woken");
    expect(idleBody.runId).toBeTruthy();

    const runs = await db.select().from(schema.runs).where(eq(schema.runs.threadId, idleThreadId));
    expect(runs).toHaveLength(2); // the cancelled queued one + the woken one
    const [woken] = runs.filter((r) => r.id !== runQueuedId);
    expect(woken!.trigger).toBe("inbox");
    const [event] = await db.select().from(schema.events).where(eq(schema.events.id, pending!.id));
    expect(event!.status).toBe("consumed");
  });

  it("SSE: the stream greets, then relays hub nudges for this thread", async () => {
    const server = serve({ fetch: app.fetch, port: 0 });
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const port = (server.address() as AddressInfo).port;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/threads/${threadId}/stream`, {
        headers: { cookie: `harness_session=${cookie.split("=")[1]}` },
      });
      expect(res.status).toBe(200);
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      const readUntil = async (needle: string, timeoutMs = 8000): Promise<boolean> => {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          if (buffer.includes(needle)) return true;
        }
        return false;
      };

      expect(await readUntil("event: hello")).toBe(true);
      hub.notify(threadId);
      expect(await readUntil("event: update")).toBe(true);
      await reader.cancel().catch(() => undefined);
    } finally {
      server.close();
    }
  });
});
