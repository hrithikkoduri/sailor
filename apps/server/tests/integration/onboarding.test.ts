/**
 * Onboarding end to end (decisions #43/#44): install → repos synced disabled →
 * user selects → THE GATE lets only selected repos trigger agent runs.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHmac, randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import type { Pool } from "pg";
import { createDb, createPool, schema, type Db } from "../../src/db/index.js";
import { runMigrations } from "../../src/db/migrate.js";
import {
  createQueueConnection,
  createQueues,
  type Queues,
} from "../../src/queue/index.js";
import { createServerApp } from "../../src/server/app.js";
import { createSession, SESSION_COOKIE } from "../../src/auth/session.js";
import type { GitHubAppService } from "../../src/github/app.js";
import type { GitHubClient } from "../../src/github/client.js";
import { loadConfig } from "../../src/config.js";

const SECRET = "test-webhook-secret";
const sign = (body: string) =>
  `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`;
const INSTALLATION = 555001;

describe("onboarding", () => {
  let pool: Pool;
  let db: Db;
  let queues: Queues;
  let app: ReturnType<typeof createServerApp>;
  let cookie: string;
  let userId: string;

  const fakeClient = {
    listInstallationRepositories: async () => [
      { full_name: "acme/alpha", private: true, default_branch: "main" },
      { full_name: "acme/beta", private: false, default_branch: "develop" },
    ],
  } as unknown as GitHubClient;

  const fakeApp: GitHubAppService = {
    getInstallation: async () => ({
      id: INSTALLATION,
      account: { login: "acme", type: "Organization" },
    }),
    clientFor: async () => fakeClient,
    tokenFor: async () => "fake-token",
    appSlug: async () => undefined,
    botIdentity: async () => undefined,
  };

  beforeAll(async () => {
    pool = createPool(loadConfig().postgres.url);
    db = createDb(pool);
    await runMigrations(db);
    queues = createQueues(createQueueConnection(loadConfig().redis.url));
    app = createServerApp({
      db,
      queues,
      webhookSecret: SECRET,
      botLogin: "sailor-dev[bot]",
      githubApp: fakeApp,
      authConfig: {
        sessionTtlDays: 30,
        secureCookies: false,
        devBypass: false,
      },
      oauth: { slug: "sailor-dev" },
      log: () => undefined,
    });

    const [user] = await db
      .insert(schema.users)
      .values({ email: "onboard@test.dev" })
      .returning();
    userId = user!.id;
    const session = await createSession(db, userId, 30);
    cookie = `${SESSION_COOKIE}=${session.token}`;
  });

  afterAll(async () => {
    await db
      .delete(schema.threads)
      .where(inArray(schema.threads.repo, ["acme/alpha", "acme/beta"]));
    await db
      .delete(schema.installations)
      .where(eq(schema.installations.installationId, INSTALLATION));
    await db.delete(schema.users).where(eq(schema.users.id, userId));
    await queues.close();
    await pool.end();
  });

  it("install → /setup (state-bound) links the installation + syncs repos disabled", async () => {
    // The install button → GitHub with a state cookie.
    const install = await app.request("/auth/install", { headers: { cookie } });
    expect(install.status).toBe(302);
    const location = install.headers.get("location")!;
    expect(location).toContain("github.com/apps/sailor-dev/installations/new");
    const state = new URL(location).searchParams.get("state")!;
    const stateCookie = (install.headers.get("set-cookie") ?? "").match(
      /sailor_install_state=([^;]+)/,
    )![1]!;

    const setup = await app.request(
      `/setup?installation_id=${INSTALLATION}&setup_action=install&state=${state}`,
      {
        headers: { cookie: `${cookie}; sailor_install_state=${stateCookie}` },
      },
    );
    expect(setup.status).toBe(302);
    expect(setup.headers.get("location")).toBe(
      `http://localhost:5173/onboarding?installation=${INSTALLATION}`,
    );

    const [inst] = await db
      .select()
      .from(schema.installations)
      .where(eq(schema.installations.installationId, INSTALLATION));
    expect(inst).toMatchObject({
      accountLogin: "acme",
      accountType: "Organization",
      userId,
    });

    const repos = await db
      .select()
      .from(schema.repositories)
      .where(eq(schema.repositories.installationRef, inst!.id));
    expect(repos.map((r) => r.fullName).sort()).toEqual([
      "acme/alpha",
      "acme/beta",
    ]);
    expect(repos.every((r) => r.enabled === false)).toBe(true); // default: nothing enabled
  });

  it("the SPA payload lists installations + repos; selecting enables exactly those", async () => {
    const before = await app.request("/api/onboarding", {
      headers: { cookie },
    });
    expect(before.status).toBe(200);
    const beforeJson = (await before.json()) as {
      installations: Array<{
        installationId: number;
        repos: Array<{ fullName: string; enabled: boolean }>;
      }>;
    };
    expect(beforeJson.installations).toHaveLength(1);
    expect(beforeJson.installations[0]!.repos.every((r) => !r.enabled)).toBe(
      true,
    );

    const save = await app.request("/api/onboarding/repos", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        installationId: INSTALLATION,
        enabled: ["acme/alpha"],
      }),
    });
    expect(save.status).toBe(200);

    const after = await app.request("/api/onboarding", { headers: { cookie } });
    const afterJson = (await after.json()) as {
      installations: Array<{
        repos: Array<{ fullName: string; enabled: boolean }>;
      }>;
    };
    const enabled = afterJson.installations[0]!.repos.filter(
      (r) => r.enabled,
    ).map((r) => r.fullName);
    expect(enabled).toEqual(["acme/alpha"]);
  });

  it("THE GATE end to end: only the selected repo's webhooks trigger agent runs", async () => {
    const post = (repo: string, body: string) =>
      app.request("/webhooks/github", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-github-event": "issues",
          "x-github-delivery": randomUUID(),
          "x-hub-signature-256": sign(body),
        },
        body,
      });
    const labeled = (repo: string, issue: number) =>
      JSON.stringify({
        action: "labeled",
        label: { name: "agent:fix" },
        issue: {
          number: issue,
          title: "gated",
          body: null,
          html_url: `https://example/${issue}`,
        },
        repository: { full_name: repo, default_branch: "main" },
        installation: { id: INSTALLATION },
        sender: { login: "octocat", type: "User" },
      });

    const allowed = await post("acme/alpha", labeled("acme/alpha", 1));
    expect(allowed.status).toBe(202);
    const [thread] = await db
      .select()
      .from(schema.threads)
      .where(eq(schema.threads.repo, "acme/alpha"));
    expect(thread).toMatchObject({ installationId: INSTALLATION, userId });

    const blocked = await post("acme/beta", labeled("acme/beta", 2));
    expect(blocked.status).toBe(202);
    expect(((await blocked.json()) as { reason?: string }).reason).toBe(
      "repo not enabled",
    );
    expect(
      await db
        .select()
        .from(schema.threads)
        .where(eq(schema.threads.repo, "acme/beta")),
    ).toHaveLength(0);
  });
});
