/**
 * The webhook door — signature, at-least-once dedup, and the labeled-issue
 * flow, against the real DB + queues. No worker runs here: runs stay queued.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHmac, randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import type { Pool } from "pg";
import { createDb, createPool, schema, type Db } from "../../src/db/index.js";
import { runMigrations } from "../../src/db/migrate.js";
import { createQueueConnection, createQueues, type Queues } from "../../src/queue/index.js";
import { createServerApp } from "../../src/http/app.js";
import { loadConfig } from "../../src/config.js";
import { seedRepo } from "../helpers/github-fixtures.js";

const SECRET = "test-webhook-secret";
const sign = (body: string) => `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`;

describe("webhook door", () => {
  let pool: Pool;
  let db: Db;
  let queues: Queues;
  let app: ReturnType<typeof createServerApp>;
  const repoNames: string[] = [];
  const deliveryIds: string[] = [];
  const installationRowIds: string[] = [];

  const nextDelivery = () => {
    const id = randomUUID();
    deliveryIds.push(id);
    return id;
  };

  /** The repo gate (decision #44): enable the repo so events are processed. */
  const seed = async (repo: string, opts: { enabled?: boolean } = {}) => {
    const seeded = await seedRepo(db, repo, opts);
    installationRowIds.push(seeded.installationRowId);
    return seeded.installationId;
  };

  beforeAll(async () => {
    pool = createPool(loadConfig().postgres.url);
    db = createDb(pool);
    await runMigrations(db);
    queues = createQueues(createQueueConnection(loadConfig().redis.url));
    app = createServerApp({ db, queues, webhookSecret: SECRET, botLogin: "sailor-bot", log: () => undefined });
  });

  afterAll(async () => {
    if (repoNames.length > 0) {
      await db.delete(schema.threads).where(inArray(schema.threads.repo, repoNames));
    }
    if (installationRowIds.length > 0) {
      await db.delete(schema.installations).where(inArray(schema.installations.id, installationRowIds));
    }
    if (deliveryIds.length > 0) {
      await db.delete(schema.webhookDeliveries).where(inArray(schema.webhookDeliveries.deliveryId, deliveryIds));
    }
    await queues.close();
    await pool.end();
  });

  const post = (body: string, opts: { event?: string; delivery: string; signature?: string | null }) =>
    app.request("/webhooks/github", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": opts.event ?? "issues",
        "x-github-delivery": opts.delivery,
        ...(opts.signature === null ? {} : { "x-hub-signature-256": opts.signature ?? sign(body) }),
      },
      body,
    });

  const newRepo = (tag: string) => {
    const repo = `test/webhook-${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    repoNames.push(repo);
    return repo;
  };

  const labeledBody = (repo: string, issue: number, installationId: number) =>
    JSON.stringify({
      action: "labeled",
      label: { name: "agent:fix" },
      issue: {
        number: issue,
        title: "add() drops negative numbers",
        body: "repro: add(-1,-2) → 0",
        html_url: `https://github.com/${repo}/issues/${issue}`,
      },
      repository: { full_name: repo, default_branch: "main" },
      installation: { id: installationId },
      sender: { login: "octocat", type: "User" },
    });

  it("label `agent:fix` → thread + consumed event + queued run", async () => {
    const repo = newRepo("ok");
    const installationId = await seed(repo);
    const delivery = nextDelivery();
    const res = await post(labeledBody(repo, 7, installationId), { delivery });

    expect(res.status).toBe(202);
    const json = (await res.json()) as { threadId: string; runId: string };
    expect(json.runId).toBeTruthy();

    const [thread] = await db.select().from(schema.threads).where(eq(schema.threads.id, json.threadId));
    expect(thread).toMatchObject({
      repo,
      issueNumber: 7,
      source: "github",
      baseRef: "main",
      headRef: "sailor/issue-7",
      state: "queued",
      installationId,
    });

    const [deliveryRow] = await db
      .select()
      .from(schema.webhookDeliveries)
      .where(eq(schema.webhookDeliveries.deliveryId, delivery));
    expect(deliveryRow!.eventKind).toBe("issues");

    const events = await db.select().from(schema.events).where(eq(schema.events.threadId, json.threadId));
    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe("issue_labeled");
    expect(events[0]!.status).toBe("consumed"); // the wake IS the turn that handles it
    expect(events[0]!.deliveryId).toBe(delivery);

    const [run] = await db.select().from(schema.runs).where(eq(schema.runs.id, json.runId));
    expect(run!.trigger).toBe("label");
    expect(run!.status).toBe("queued");
    expect(run!.task).toContain("add() drops negative numbers");
    expect(run!.task).toContain(`https://github.com/${repo}/issues/7`);
  });

  it("an issue created WITH agent:fix opens a thread too", async () => {
    const repo = newRepo("opened");
    const installationId = await seed(repo);
    const body = JSON.stringify({
      action: "opened",
      issue: {
        number: 77,
        title: "created with the label",
        body: "no separate labeled event",
        html_url: `https://github.com/${repo}/issues/77`,
        labels: [{ name: "agent:fix" }],
      },
      repository: { full_name: repo, default_branch: "main" },
      installation: { id: installationId },
      sender: { login: "octocat", type: "User" },
    });
    const res = await post(body, { delivery: nextDelivery() });
    expect(res.status).toBe(202);
    const json = (await res.json()) as { threadId: string; runId: string };
    const [thread] = await db.select().from(schema.threads).where(eq(schema.threads.id, json.threadId));
    expect(thread).toMatchObject({ repo, issueNumber: 77, state: "queued" });
  });

  it("relabel while a run is active: the event waits in the inbox (wake refused)", async () => {
    const repo = newRepo("busy");
    const installationId = await seed(repo);
    const first = await post(labeledBody(repo, 8, installationId), { delivery: nextDelivery() });
    expect(first.status).toBe(202);

    const res = await post(labeledBody(repo, 8, installationId), { delivery: nextDelivery() });
    expect(res.status).toBe(202);
    const json = (await res.json()) as { threadId: string; runId: string | null };
    expect(json.runId).toBeNull();

    const runs = await db.select().from(schema.runs).where(eq(schema.runs.threadId, json.threadId));
    expect(runs).toHaveLength(1); // still just the first run
    const events = await db.select().from(schema.events).where(eq(schema.events.threadId, json.threadId));
    expect(events.map((e) => e.status).sort()).toEqual(["consumed", "pending"]);
  });

  it("duplicate deliveries are acknowledged exactly once (dedup ledger)", async () => {
    const repo = newRepo("dup");
    const installationId = await seed(repo);
    const delivery = nextDelivery();
    expect((await post(labeledBody(repo, 9, installationId), { delivery })).status).toBe(202);
    const res2 = await post(labeledBody(repo, 9, installationId), { delivery });
    expect(res2.status).toBe(200);
    expect(((await res2.json()) as { duplicate?: boolean }).duplicate).toBe(true);

    const threads = await db.select().from(schema.threads).where(eq(schema.threads.repo, repo));
    expect(threads).toHaveLength(1);
    expect(await db.select().from(schema.runs).where(eq(schema.runs.threadId, threads[0]!.id))).toHaveLength(1);
    expect(await db.select().from(schema.events).where(eq(schema.events.threadId, threads[0]!.id))).toHaveLength(1);
  });

  it("a bad signature is rejected before anything is recorded", async () => {
    const repo = newRepo("bad");
    const installationId = await seed(repo);
    const delivery = nextDelivery();
    const res = await post(labeledBody(repo, 10, installationId), { delivery, signature: `sha256=${"0".repeat(64)}` });
    expect(res.status).toBe(401);
    expect(await db.select().from(schema.threads).where(eq(schema.threads.repo, repo))).toHaveLength(0);
    expect(
      await db.select().from(schema.webhookDeliveries).where(eq(schema.webhookDeliveries.deliveryId, delivery)),
    ).toHaveLength(0);
  });

  it("ping is recorded and acknowledged without side effects", async () => {
    const delivery = nextDelivery();
    const res = await post(JSON.stringify({ zen: "keep it simple" }), { event: "ping", delivery });
    expect(res.status).toBe(200);
    const [row] = await db
      .select()
      .from(schema.webhookDeliveries)
      .where(eq(schema.webhookDeliveries.deliveryId, delivery));
    expect(row!.eventKind).toBe("ping");
  });

  it("terminal threads are left alone (wake guard) even when labeled again", async () => {
    const repo = newRepo("dead");
    const installationId = await seed(repo);
    const [thread] = await db
      .insert(schema.threads)
      .values({
        repo,
        issueNumber: 11,
        source: "github",
        headRef: "sailor/issue-11",
        installationId,
        state: "merged",
      })
      .returning();

    const res = await post(labeledBody(repo, 11, installationId), { delivery: nextDelivery() });
    expect(res.status).toBe(200);
    expect(await db.select().from(schema.runs).where(eq(schema.runs.threadId, thread!.id))).toHaveLength(0);
    expect(await db.select().from(schema.events).where(eq(schema.events.threadId, thread!.id))).toHaveLength(0);
  });

  it("THE REPO GATE: a repo that was never enabled in onboarding is ignored", async () => {
    const repo = newRepo("gated");
    const installationId = await seed(repo, { enabled: false }); // installed, NOT selected
    const res = await post(labeledBody(repo, 12, installationId), { delivery: nextDelivery() });

    expect(res.status).toBe(202);
    expect(((await res.json()) as { reason?: string }).reason).toBe("repo not enabled");
    expect(await db.select().from(schema.threads).where(eq(schema.threads.repo, repo))).toHaveLength(0);
  });

  it("repos whose installation we don't know are ignored (App-only mode)", async () => {
    const repo = newRepo("noinstall");
    const body = JSON.stringify({
      action: "labeled",
      label: { name: "agent:fix" },
      issue: { number: 13, title: "x", body: null, html_url: "https://example/13" },
      repository: { full_name: repo, default_branch: "main" },
      sender: { login: "octocat", type: "User" },
    });
    const res = await post(body, { delivery: nextDelivery() });

    expect(res.status).toBe(202);
    expect(((await res.json()) as { reason?: string }).reason).toBe("missing installation");
    expect(await db.select().from(schema.threads).where(eq(schema.threads.repo, repo))).toHaveLength(0);
  });
});
