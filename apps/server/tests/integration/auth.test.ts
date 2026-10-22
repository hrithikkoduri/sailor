/**
 * Auth flows (decision #41): signup/login/logout with argon2id, GitHub
 * sign-in (faked OAuth), and the dev bypass (decision #43). Real DB.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import type { Pool } from "pg";
import { createDb, createPool, schema, type Db } from "../../src/db/index.js";
import { runMigrations } from "../../src/db/migrate.js";
import { createQueueConnection, createQueues, type Queues } from "../../src/queue/index.js";
import { createServerApp } from "../../src/http/app.js";
import { createLimiter } from "../../src/http/rate-limit.js";
import { loadConfig } from "../../src/config.js";

const SECRET = "test-webhook-secret";

const cookieFor = (res: Response, name: string): string | undefined => {
  const raw = res.headers.get("set-cookie") ?? "";
  const match = raw.match(new RegExp(`${name}=([^;]+)`));
  return match ? `${name}=${match[1]}` : undefined;
};

describe("auth flows", () => {
  let pool: Pool;
  let db: Db;
  let queues: Queues;
  let app: ReturnType<typeof createServerApp>;
  let bypassApp: ReturnType<typeof createServerApp>;
  const emails: string[] = ["alice@test.dev", "bob@test.dev"];
  const githubIds: number[] = [4242];

  const fakeOauthFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/login/oauth/access_token")) {
      expect(String(init?.method)).toBe("POST");
      return new Response(JSON.stringify({ access_token: "ghu_1" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.endsWith("/user")) {
      return new Response(
        JSON.stringify({
          id: 4242,
          login: "octocat",
          name: "Octo Cat",
          avatar_url: "https://avatars/octo",
          email: "alice@test.dev", // matches the email account → linking
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;

  beforeAll(async () => {
    pool = createPool(loadConfig().postgres.url);
    db = createDb(pool);
    await runMigrations(db);
    queues = createQueues(createQueueConnection(loadConfig().redis.url));
    app = createServerApp({
      db,
      queues,
      webhookSecret: SECRET,
      authConfig: { sessionTtlDays: 30, secureCookies: false, devBypass: false },
      oauth: { clientId: "cid", clientSecret: "csec", fetchFn: fakeOauthFetch },
      log: () => undefined,
    });
    bypassApp = createServerApp({
      db,
      queues,
      webhookSecret: SECRET,
      authConfig: { sessionTtlDays: 30, secureCookies: false, devBypass: true },
      log: () => undefined,
    });
  });

  afterAll(async () => {
    await db.delete(schema.users).where(inArray(schema.users.email, [...emails, "dev@localhost"]));
    await db.delete(schema.users).where(inArray(schema.users.githubUserId, githubIds));
    await queues.close();
    await pool.end();
  });

  const postJson = (target: ReturnType<typeof createServerApp>, path: string, body: unknown, cookie?: string) =>
    target.request(path, {
      method: "POST",
      headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(body),
    });

  it("signup → session cookie → me; duplicate and weak passwords are rejected", async () => {
    const res = await postJson(app, "/auth/signup", { email: "alice@test.dev", password: "hunter2hunter2" });
    expect(res.status).toBe(201);
    const cookie = cookieFor(res, "sailor_session");
    expect(cookie).toBeTruthy();

    const me = await app.request("/auth/me", { headers: { cookie: cookie! } });
    expect(me.status).toBe(200);
    expect(((await me.json()) as { user: { email: string } }).user.email).toBe("alice@test.dev");

    const dup = await postJson(app, "/auth/signup", { email: "alice@test.dev", password: "hunter2hunter2" });
    expect(dup.status).toBe(409);
    const weak = await postJson(app, "/auth/signup", { email: "bob@test.dev", password: "short" });
    expect(weak.status).toBe(400);
  });

  it("login: wrong password 401, right password works, logout kills the session", async () => {
    expect((await postJson(app, "/auth/login", { email: "alice@test.dev", password: "nope-wrong" })).status).toBe(401);

    const res = await postJson(app, "/auth/login", { email: "alice@test.dev", password: "hunter2hunter2" });
    expect(res.status).toBe(200);
    const cookie = cookieFor(res, "sailor_session")!;

    const logout = await postJson(app, "/auth/logout", {}, cookie);
    expect(logout.status).toBe(200);
    expect((await app.request("/auth/me", { headers: { cookie } })).status).toBe(401);
  });

  it("GitHub sign-in: authorize → callback → linked user → onboarding redirect", async () => {
    const start = await app.request("/auth/github");
    expect(start.status).toBe(302);
    const location = start.headers.get("location")!;
    expect(location).toContain("github.com/login/oauth/authorize");
    const state = new URL(location).searchParams.get("state")!;
    const stateCookie = cookieFor(start, "sailor_oauth_state")!;

    const callback = await app.request(`/auth/github/callback?code=xyz&state=${state}`, {
      headers: { cookie: stateCookie },
    });
    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe("http://localhost:5173/onboarding");
    const session = cookieFor(callback, "sailor_session")!;

    const me = await app.request("/auth/me", { headers: { cookie: session } });
    const user = ((await me.json()) as { user: { login: string; id: string } }).user;
    expect(user.login).toBe("octocat");

    // The GitHub email matched alice's account → SAME user row (linked).
    const [row] = await db.select().from(schema.users).where(eq(schema.users.email, "alice@test.dev"));
    expect(row!.id).toBe(user.id);
    expect(row!.githubUserId).toBe(4242);

    // State mismatch is rejected.
    const bad = await app.request(`/auth/github/callback?code=xyz&state=wrong`, {
      headers: { cookie: stateCookie },
    });
    expect(bad.status).toBe(400);
  });

  it("DEV_AUTH_BYPASS: requests without a session resolve to the dev user", async () => {
    const me = await bypassApp.request("/auth/me");
    expect(me.status).toBe(200);
    expect(((await me.json()) as { user: { email: string } }).user.email).toBe("dev@localhost");
  });

  it("login and signup are rate limited per client address", async () => {
    const limitedApp = createServerApp({
      db,
      queues,
      webhookSecret: SECRET,
      authConfig: { sessionTtlDays: 30, secureCookies: false, devBypass: false },
      authLimiters: {
        login: createLimiter({ limit: 2, windowMs: 60_000 }),
        signup: createLimiter({ limit: 2, windowMs: 60_000 }),
      },
      log: () => undefined,
    });
    const credentials = { email: "alice@test.dev", password: "hunter2hunter2" };

    // Failed attempts count too: one wrong password, then the real login,
    // exhausts a budget of two.
    expect((await postJson(limitedApp, "/auth/login", { ...credentials, password: "nope-wrong" })).status).toBe(401);
    expect((await postJson(limitedApp, "/auth/login", credentials)).status).toBe(200);

    const blocked = await postJson(limitedApp, "/auth/login", credentials);
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);

    // Each route has its own bucket.
    expect((await postJson(limitedApp, "/auth/signup", { email: "bob@test.dev", password: "short" })).status).toBe(400);
    expect((await postJson(limitedApp, "/auth/signup", { email: "bob@test.dev", password: "short" })).status).toBe(400);
    expect((await postJson(limitedApp, "/auth/signup", { email: "bob@test.dev", password: "short" })).status).toBe(429);
  });
});
