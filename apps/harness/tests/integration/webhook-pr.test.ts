/**
 * The PR lifecycle door (step 13): check_run → queue, reviews → interject,
 * our own pushes → acknowledge, PR closed → terminal. Real DB + queues.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHmac, randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import type { Pool } from "pg";
import { createDb, createPool, schema, type Db } from "../../src/db/index.js";
import { runMigrations } from "../../src/db/migrate.js";
import { createQueueConnection, createQueues, type Queues } from "../../src/queue/index.js";
import { createServerApp } from "../../src/server/app.js";
import { loadConfig } from "../../src/config.js";

const SECRET = "test-webhook-secret";
const sign = (body: string) => `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`;

describe("webhook: PR lifecycle", () => {
  let pool: Pool;
  let db: Db;
  let queues: Queues;
  let app: ReturnType<typeof createServerApp>;
  const threadIds: string[] = [];
  const deliveryIds: string[] = [];

  const nextDelivery = () => {
    const id = randomUUID();
    deliveryIds.push(id);
    return id;
  };

  beforeAll(async () => {
    pool = createPool(loadConfig().postgres.url);
    db = createDb(pool);
    await runMigrations(db);
    queues = createQueues(createQueueConnection(loadConfig().redis.url));
    app = createServerApp({ db, queues, webhookSecret: SECRET, botLogin: "harness-bot", log: () => undefined });
  });

  afterAll(async () => {
    if (threadIds.length > 0) await db.delete(schema.threads).where(inArray(schema.threads.id, threadIds));
    if (deliveryIds.length > 0) {
      await db.delete(schema.webhookDeliveries).where(inArray(schema.webhookDeliveries.deliveryId, deliveryIds));
    }
    await queues.close();
    await pool.end();
  });

  const post = (body: string, opts: { event: string; delivery: string }) =>
    app.request("/webhooks/github", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": opts.event,
        "x-github-delivery": opts.delivery,
        "x-hub-signature-256": sign(body),
      },
      body,
    });

  const newThread = async (tag: string, issue: number) => {
    const repo = `test/prlife-${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const [thread] = await db
      .insert(schema.threads)
      .values({
        repo,
        issueNumber: issue,
        source: "github",
        headRef: `harness/issue-${issue}`,
        prNumber: issue,
        state: "pr_open",
      })
      .returning();
    threadIds.push(thread!.id);
    return thread!;
  };

  it("check_run failure → a babysit turn is queued", async () => {
    const thread = await newThread("ci", 40);
    const body = JSON.stringify({
      action: "completed",
      check_run: {
        name: "unit",
        conclusion: "failure",
        html_url: "https://example/ci/1",
        head_sha: "sha-40",
        check_suite: { head_branch: "harness/issue-40" },
        pull_requests: [{ number: 40 }],
      },
      repository: { full_name: thread.repo },
      sender: { login: "ci-bot", type: "Bot" },
    });

    const res = await post(body, { event: "check_run", delivery: nextDelivery() });
    expect(res.status).toBe(202);
    const json = (await res.json()) as { threadId: string; runId: string };
    expect(json.runId).toBeTruthy();

    const [run] = await db.select().from(schema.runs).where(eq(schema.runs.id, json.runId));
    expect(run!.trigger).toBe("babysit_ci");
    expect(run!.task).toContain("CI failed");
    expect(run!.task).toContain("unit");
  });

  it("a review while a run is active interjects (durable cancel) and parks the event", async () => {
    const thread = await newThread("review", 41);
    const [active] = await db
      .insert(schema.runs)
      .values({ threadId: thread.id, trigger: "manual", status: "running", heartbeatAt: new Date() })
      .returning();

    const body = JSON.stringify({
      action: "submitted",
      review: {
        state: "changes_requested",
        body: "please use approach B",
        html_url: "https://example/review/1",
        user: { login: "octocat", type: "User" },
      },
      pull_request: { number: 41 },
      repository: { full_name: thread.repo },
      sender: { login: "octocat", type: "User" },
    });

    const res = await post(body, { event: "pull_request_review", delivery: nextDelivery() });
    expect(res.status).toBe(202);
    const json = (await res.json()) as { threadId: string; runId: string | null };
    expect(json.runId).toBeNull(); // parked behind the active run

    const [after] = await db.select().from(schema.runs).where(eq(schema.runs.id, active!.id));
    expect(after!.cancelRequestedAt).not.toBeNull(); // the durable interject flag

    const events = await db.select().from(schema.events).where(eq(schema.events.threadId, thread.id));
    expect(events.map((e) => e.status)).toEqual(["pending"]);
    expect(events[0]!.kind).toBe("pull_request_review");
  });

  it("our own push → an acknowledgment turn is queued (no action)", async () => {
    const thread = await newThread("push", 42);
    const body = JSON.stringify({
      ref: "refs/heads/harness/issue-42",
      after: "sha-42",
      commits: [{ id: "a" }, { id: "b" }],
      repository: { full_name: thread.repo },
      sender: { login: "harness-bot", type: "Bot" },
    });

    const res = await post(body, { event: "push", delivery: nextDelivery() });
    expect(res.status).toBe(202);
    const json = (await res.json()) as { runId: string };
    const [run] = await db.select().from(schema.runs).where(eq(schema.runs.id, json.runId));
    expect(run!.trigger).toBe("inbox");
    expect(run!.task).toContain("No action needed");
    expect(run!.task).toContain("2 commits");
  });

  it("foreign pushes are ignored", async () => {
    const thread = await newThread("fpush", 43);
    const body = JSON.stringify({
      ref: "refs/heads/harness/issue-43",
      after: "sha-43",
      commits: [{ id: "a" }],
      repository: { full_name: thread.repo },
      sender: { login: "someone-else", type: "User" },
    });

    const res = await post(body, { event: "push", delivery: nextDelivery() });
    expect(res.status).toBe(202);
    expect(((await res.json()) as { ignored?: boolean }).ignored).toBe(true);
    expect(await db.select().from(schema.runs).where(eq(schema.runs.threadId, thread.id))).toHaveLength(0);
  });

  it("human comment on the PR (idle) → a turn with the comment is queued", async () => {
    const thread = await newThread("comment", 45);
    const body = JSON.stringify({
      action: "created",
      comment: { body: "why does X behave this way?", html_url: "https://example/c/1", user: { login: "octocat", type: "User" } },
      issue: { number: 45, pull_request: { url: "https://example/pr/45" } },
      repository: { full_name: thread.repo },
      sender: { login: "octocat", type: "User" },
    });

    const res = await post(body, { event: "issue_comment", delivery: nextDelivery() });
    expect(res.status).toBe(202);
    const json = (await res.json()) as { runId: string };
    const [run] = await db.select().from(schema.runs).where(eq(schema.runs.id, json.runId));
    expect(run!.trigger).toBe("babysit_comment");
    expect(run!.task).toContain("why does X behave this way?");
  });

  it("PR closed+merged → the thread goes terminal", async () => {
    const thread = await newThread("merged", 44);
    const body = JSON.stringify({
      action: "closed",
      pull_request: { number: 44, merged: true, html_url: "https://example/pr/44", head: { ref: "harness/issue-44" } },
      repository: { full_name: thread.repo },
      sender: { login: "octocat", type: "User" },
    });

    const res = await post(body, { event: "pull_request", delivery: nextDelivery() });
    expect(res.status).toBe(200);
    const [after] = await db.select().from(schema.threads).where(eq(schema.threads.id, thread.id));
    expect(after!.state).toBe("merged");
  });
});
