/**
 * The dashboard API (step 17b): threads list, thread detail, run + trace,
 * the three small actions (cancel / keep-sandbox / interject), and the SSE
 * stream — all behind session auth, against a real Postgres + Redis.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { and, eq, inArray } from "drizzle-orm";
import type { Pool } from "pg";
import { createDb, createPool, schema, type Db } from "../../src/db/index.js";
import { runMigrations } from "../../src/db/migrate.js";
import {
  createQueueConnection,
  createQueues,
  type Queues,
} from "../../src/queue/index.js";
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
  let chatThreadId: string;
  const terminalThreadIds: string[] = [];
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
      authConfig: {
        sessionTtlDays: 30,
        secureCookies: false,
        devBypass: false,
      },
      log: () => undefined,
    });

    const [user] = await db
      .insert(schema.users)
      .values({ email: `api-${stamp}@test.dev` })
      .returning();
    userId = user!.id;
    const [other] = await db
      .insert(schema.users)
      .values({ email: `api-other-${stamp}@test.dev` })
      .returning();
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
        headRef: `sailor/issue-1`,
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
      .values({
        repo: `test/api-idle-${stamp}`,
        issueNumber: 3,
        source: "github",
        state: "queued",
        userId,
      })
      .returning();
    idleThreadId = idle!.id;
    await appendEvent(db, {
      threadId: idleThreadId,
      kind: "issue_comment",
      payload: { body: "please also handle the edge case", author: "octocat" },
    });

    // A clean thread for the chat flows (isolation from the interject test).
    const [chat] = await db
      .insert(schema.threads)
      .values({
        repo: `test/api-chat-${stamp}`,
        issueNumber: 4,
        source: "github",
        state: "queued",
        userId,
      })
      .returning();
    chatThreadId = chat!.id;

    // A consumed issue_labeled event — the conversation feed's human side.
    const labeled = await appendEvent(db, {
      threadId,
      kind: "issue_labeled",
      payload: {
        number: 1,
        title: "add() drops negative numbers",
        label: "agent:fix",
      },
    });
    await db
      .update(schema.events)
      .set({ status: "consumed", consumedAt: new Date() })
      .where(eq(schema.events.id, labeled.id));

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
      {
        runId: runOkId,
        seq: 0,
        type: "run_started",
        payload: {
          type: "run_started",
          task: "Fix issue #1",
          phases: ["reproduce", "fix", "verify"],
        },
      },
      {
        runId: runOkId,
        seq: 1,
        type: "phase_started",
        payload: { type: "phase_started", phase: "reproduce" },
      },
      {
        runId: runOkId,
        seq: 2,
        type: "tool_call",
        payload: {
          type: "tool_call",
          phase: "reproduce",
          step: 1,
          name: "run_tests",
          input: {},
        },
      },
      {
        runId: runOkId,
        seq: 3,
        type: "llm_call_finished",
        payload: {
          type: "llm_call_finished",
          phase: "verify",
          step: 9,
          text: "Done — the fix is verified.",
          toolCalls: [],
          textChars: 29,
          toolCallsCount: 0,
          usage: { promptTokens: 900, completionTokens: 90 },
          latencyMs: 1200,
        },
      },
      {
        runId: runOkId,
        seq: 4,
        type: "run_finished",
        payload: {
          type: "run_finished",
          ok: true,
          steps: 9,
          usage: { promptTokens: 1234, completionTokens: 567 },
          reason: "finished",
          disposition: "done",
        },
      },
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
      .values({
        threadId: idleThreadId,
        status: "queued",
        trigger: "label",
        createdAt: new Date(stamp),
      })
      .returning();
    runQueuedId = runQueued!.id;

    const events = await db
      .select()
      .from(schema.events)
      .where(eq(schema.events.threadId, threadId));
    void events;
  });

  afterAll(async () => {
    const threadIds = [
      threadId,
      hiddenThreadId,
      idleThreadId,
      chatThreadId,
      ...terminalThreadIds,
    ];
    await db
      .delete(schema.events)
      .where(inArray(schema.events.threadId, threadIds));
    await db
      .delete(schema.threads)
      .where(inArray(schema.threads.id, threadIds));
    await db
      .delete(schema.users)
      .where(inArray(schema.users.id, [userId, otherUserId]));
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
      threads: Array<{
        id: string;
        latestRun: { id: string; status: string } | null;
        pendingEvents: number;
      }>;
    };
    const ids = body.threads.map((t) => t.id);
    expect(ids).toContain(threadId);
    expect(ids).toContain(idleThreadId);
    expect(ids).not.toContain(hiddenThreadId);

    const mine = body.threads.find((t) => t.id === threadId)!;
    expect(mine.latestRun).toMatchObject({ id: runLiveId, status: "running" });
  });

  it("thread detail: runs newest-first + pending events; hidden thread 404s", async () => {
    const res = await app.request(`/api/threads/${threadId}`, {
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      thread: { id: string; repo: string; turnsUsed: number; prUrl: string };
      runs: Array<{ id: string; status: string; agentText: string | null }>;
      events: Array<{ id: string; kind: string; status: string }>;
      pendingEvents: unknown[];
    };
    expect(body.thread).toMatchObject({ id: threadId, turnsUsed: 2 });
    expect(body.runs.map((r) => r.id)).toEqual([runLiveId, runOkId]);
    expect(body.runs.find((r) => r.id === runOkId)?.agentText).toBe(
      "Done — the fix is verified.",
    );
    expect(body.events.map((e) => e.kind)).toContain("issue_labeled");
    expect(body.pendingEvents).toHaveLength(0);

    expect(
      (
        await app.request(`/api/threads/${hiddenThreadId}`, {
          headers: { cookie },
        })
      ).status,
    ).toBe(404);
  });

  it("refresh mid-stream reconstructs partial text and reasoning from persisted chunks", async () => {
    await db.insert(schema.traceEvents).values([
      {
        runId: runLiveId,
        seq: 0,
        type: "llm_call_started",
        payload: { step: 1, phase: "respond" },
      },
      {
        runId: runLiveId,
        seq: 1,
        type: "llm_reasoning_delta",
        payload: { text: "Checking earlier work." },
      },
      {
        runId: runLiveId,
        seq: 2,
        type: "llm_text_delta",
        payload: { text: "Here is the partial reply." },
      },
    ]);
    const res = await app.request(`/api/threads/${threadId}`, {
      headers: { cookie },
    });
    const body = (await res.json()) as {
      runs: Array<{
        id: string;
        conversation: {
          parts: Array<{ kind: string; text: string }>;
          sequence: number;
          finished: boolean;
        };
      }>;
    };
    const live = body.runs.find((run) => run.id === runLiveId)!.conversation;
    expect(live.parts.map((part) => part.kind)).toEqual(["reasoning", "text"]);
    expect(live.parts[1]!.text).toBe("Here is the partial reply.");
    expect(live.finished).toBe(false);
    expect(live.sequence).toBe(2);
  });

  it("run detail: full trace in sequence order", async () => {
    const res = await app.request(`/api/runs/${runOkId}`, {
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      run: { id: string; steps: number; tokensIn: number };
      trace: Array<{ seq: number; type: string }>;
    };
    expect(body.run).toMatchObject({ id: runOkId, steps: 9, tokensIn: 1234 });
    expect(body.trace.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4]);
    expect(body.trace.map((e) => e.type)).toEqual([
      "run_started",
      "phase_started",
      "tool_call",
      "llm_call_finished",
      "run_finished",
    ]);
  });

  it("chat: idle → woken, queued → waits, busy → queues without cancelling, terminal → refuses", async () => {
    const post = (threadId: string, text: string) =>
      app.request(`/api/threads/${threadId}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ text }),
      });

    // idle: the message becomes the turn right away.
    const first = await post(
      chatThreadId,
      "Please also cover the negative case.",
    );
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as {
      interjected: boolean;
      runId: string | null;
    };
    expect(firstBody.runId).toBeTruthy();
    expect(firstBody.interjected).toBe(false);

    const [chatRun] = await db
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.threadId, chatThreadId));
    expect(chatRun!.trigger).toBe("inbox");
    expect(chatRun!.agent).toBe("chat"); // a chat-only batch runs the chat agent (decision #48)
    const [chatEvent] = await db
      .select()
      .from(schema.events)
      .where(eq(schema.events.threadId, chatThreadId));
    expect(chatEvent!.kind).toBe("chat_message");
    expect(chatEvent!.status).toBe("consumed");

    // queued: the active run owns the turn — the message waits genuinely.
    const second = await post(
      chatThreadId,
      "One more thing — add a test for zero.",
    );
    const secondBody = (await second.json()) as {
      interjected: boolean;
      runId: string | null;
    };
    expect(secondBody.interjected).toBe(false);
    expect(secondBody.runId).toBe(chatRun!.id);
    const pendingRows = await db
      .select()
      .from(schema.events)
      .where(
        and(
          eq(schema.events.threadId, chatThreadId),
          eq(schema.events.status, "pending"),
        ),
      );
    expect(pendingRows).toHaveLength(1);

    // busy: the message QUEUES behind the running turn — sending must not
    // cancel anything; interjection stays the explicit /interject action.
    await db
      .update(schema.runs)
      .set({ status: "running", startedAt: new Date() })
      .where(eq(schema.runs.id, chatRun!.id));
    const third = await post(
      chatThreadId,
      "Actually, prioritize the zero case.",
    );
    const thirdBody = (await third.json()) as {
      interjected: boolean;
      runId: string | null;
    };
    expect(thirdBody.interjected).toBe(false);
    expect(thirdBody.runId).toBe(chatRun!.id);
    const [stillRunning] = await db
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.id, chatRun!.id));
    expect(stillRunning!.cancelRequestedAt).toBeNull();
    const pendingNow = await db
      .select()
      .from(schema.events)
      .where(
        and(
          eq(schema.events.threadId, chatThreadId),
          eq(schema.events.status, "pending"),
        ),
      );
    expect(pendingNow).toHaveLength(2); // both messages wait for the worker's drain

    // terminal threads take no more turns.
    const [done] = await db
      .insert(schema.threads)
      .values({
        repo: `test/api-done-${stamp}`,
        issueNumber: 9,
        source: "github",
        state: "merged",
        userId,
      })
      .returning();
    terminalThreadIds.push(done!.id);
    expect((await post(done!.id, "hello?")).status).toBe(409);
  });

  it("cancel: a running run gets the durable flag; a queued run flips to cancelled", async () => {
    const live = await app.request(`/api/runs/${runLiveId}/cancel`, {
      method: "POST",
      headers: { cookie },
    });
    expect(live.status).toBe(200);
    expect(((await live.json()) as { action: string }).action).toBe(
      "cancel-requested",
    );
    const [runLive] = await db
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.id, runLiveId));
    expect(runLive!.cancelRequestedAt).toBeTruthy();

    const queued = await app.request(`/api/runs/${runQueuedId}/cancel`, {
      method: "POST",
      headers: { cookie },
    });
    expect(queued.status).toBe(200);
    expect(((await queued.json()) as { action: string }).action).toBe(
      "cancelled-queued",
    );
    const [runQueued] = await db
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.id, runQueuedId));
    expect(runQueued!.status).toBe("cancelled");
    expect(runQueued!.finishedAt).toBeTruthy();
  });

  it("keep-sandbox flips the run flag", async () => {
    const res = await app.request(`/api/runs/${runLiveId}/keep-sandbox`, {
      method: "POST",
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    const [run] = await db
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.id, runLiveId));
    expect(run!.keepSandbox).toBe(true);
  });

  it("interject: busy run → cancel requested; idle thread → the event wakes a run", async () => {
    // Busy: point the interject at the idle thread's run… first put an active
    // run on the busy thread, then interject the pending event on the idle one.
    const busyEvent = await db
      .insert(schema.events)
      .values({
        threadId,
        kind: "pull_request_review",
        payload: { author: "octocat", body: "nit: rename this" },
      })
      .returning();
    pendingEventId = String(busyEvent[0]!.id);

    const busy = await app.request(`/api/events/${pendingEventId}/interject`, {
      method: "POST",
      headers: { cookie },
    });
    expect(busy.status).toBe(200);
    expect(((await busy.json()) as { action: string }).action).toBe(
      "interjected",
    );

    const [liveRun] = await db
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.id, runLiveId));
    expect(liveRun!.cancelRequestedAt).toBeTruthy();

    // Idle: the pending event on the idle thread wakes a run right now.
    const [pending] = await db
      .select()
      .from(schema.events)
      .where(eq(schema.events.threadId, idleThreadId));
    const idle = await app.request(
      `/api/events/${String(pending!.id)}/interject`,
      {
        method: "POST",
        headers: { cookie },
      },
    );
    expect(idle.status).toBe(200);
    const idleBody = (await idle.json()) as {
      action: string;
      runId: string | null;
    };
    expect(idleBody.action).toBe("woken");
    expect(idleBody.runId).toBeTruthy();

    const runs = await db
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.threadId, idleThreadId));
    expect(runs).toHaveLength(2); // the cancelled queued one + the woken one
    const [woken] = runs.filter((r) => r.id !== runQueuedId);
    expect(woken!.trigger).toBe("inbox");
    expect(woken!.agent).toBe("coding"); // a GitHub event is a coding turn
    const [event] = await db
      .select()
      .from(schema.events)
      .where(eq(schema.events.id, pending!.id));
    expect(event!.status).toBe("consumed");
  });

  it("cancel: withdraws only a pending dashboard message", async () => {
    const [queued] = await db
      .insert(schema.events)
      .values({
        threadId,
        kind: "chat_message",
        payload: { author: "hrithik", body: "hold on — withdraw this" },
        status: "pending",
      })
      .returning();

    const res = await app.request(`/api/events/${String(queued!.id)}/cancel`, {
      method: "POST",
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { action: string }).action).toBe("cancelled");
    const rows = await db
      .select()
      .from(schema.events)
      .where(eq(schema.events.id, queued!.id));
    expect(rows).toHaveLength(0);

    // Consumed messages are history; GitHub events are not ours to delete.
    const [consumed] = await db
      .insert(schema.events)
      .values({
        threadId,
        kind: "chat_message",
        payload: { author: "hrithik", body: "already picked up" },
        status: "consumed",
        consumedAt: new Date(),
      })
      .returning();
    const consumedRes = await app.request(
      `/api/events/${String(consumed!.id)}/cancel`,
      { method: "POST", headers: { cookie } },
    );
    expect(consumedRes.status).toBe(409);

    const [review] = await db
      .insert(schema.events)
      .values({
        threadId,
        kind: "pull_request_review",
        payload: { author: "octocat", body: "nit: rename this" },
      })
      .returning();
    const reviewRes = await app.request(
      `/api/events/${String(review!.id)}/cancel`,
      { method: "POST", headers: { cookie } },
    );
    expect(reviewRes.status).toBe(409);
  });

  it("whole-thread trace: totals + spans across runs, deltas excluded, hidden threads 404", async () => {
    // Seed a delta row that must NOT appear (reconstructable from the finish).
    await db.insert(schema.traceEvents).values({
      runId: runOkId,
      seq: 5,
      type: "llm_text_delta",
      payload: { type: "llm_text_delta", text: "tok" },
    });

    const res = await app.request(`/api/threads/${threadId}/trace`, {
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      totals: { runs: number; tokensIn: number; usd: string };
      runs: Array<{ id: string; steps: number }>;
      spans: Array<{ type: string; runId: string }>;
    };
    expect(body.totals.runs).toBe(2);
    expect(body.totals.tokensIn).toBe(1234); // runOk only; runLive has none yet
    expect(body.runs.find((r) => r.id === runOkId)?.steps).toBe(9);
    expect(body.spans.length).toBeGreaterThan(0);
    expect(body.spans.map((s) => s.type)).not.toContain("llm_text_delta");
    expect(body.spans.every((s) => typeof s.runId === "string")).toBe(true);

    expect(
      (
        await app.request(`/api/threads/${hiddenThreadId}/trace`, {
          headers: { cookie },
        })
      ).status,
    ).toBe(404);
    expect((await app.request(`/api/threads/${threadId}/trace`)).status).toBe(
      401,
    );
  });

  it("SSE: the stream greets, then relays hub nudges for this thread", async () => {
    const server = serve({ fetch: app.fetch, port: 0 });
    await new Promise<void>((resolve) =>
      server.once("listening", () => resolve()),
    );
    const port = (server.address() as AddressInfo).port;

    try {
      const res = await fetch(
        `http://127.0.0.1:${port}/api/threads/${threadId}/stream`,
        {
          headers: { cookie: `sailor_session=${cookie.split("=")[1]}` },
        },
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("x-accel-buffering")).toBe("no");
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      const readUntil = async (
        needle: string,
        timeoutMs = 8000,
      ): Promise<boolean> => {
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
      hub.send(
        threadId,
        `event: live\ndata: ${JSON.stringify({ threadId, runId: runLiveId, step: 1, kind: "delta", text: "Partial reply" })}\n\n`,
      );
      expect(await readUntil("Partial reply")).toBe(true);
      await reader.cancel().catch(() => undefined);
    } finally {
      server.close();
    }
  });
});
