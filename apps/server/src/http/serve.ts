/**
 * `sailor serve` — the long-lived webhook intake service.
 *
 * Writes Postgres + the queue only: a labeled issue becomes a thread and a
 * queued run; the worker (separate process, same DB) executes it.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { serve } from "@hono/node-server";
import { Redis } from "ioredis";
import { loadConfig } from "../config.js";
import { createDb, createPool } from "../db/index.js";
import { createQueueConnection, createQueues } from "../queue/index.js";
import { createGitHubApp } from "../services/github/app.js";
import { createServerApp } from "./app.js";
import { createRedisLimiter } from "./rate-limit.js";
import { createStreamHub, LIVE_CHANNEL, UPDATES_CHANNEL } from "./stream.js";

export async function serveCommand(args: string[]): Promise<number> {
  const cfg = loadConfig();
  const skipVerify = args.includes("--no-verify");
  if (!cfg.github.webhookSecret && !skipVerify) {
    process.stderr.write(
      "GITHUB_WEBHOOK_SECRET is not set — refusing to start. (Use --no-verify for local curl testing only.)\n",
    );
    return 1;
  }

  const pool = createPool(cfg.postgres.url);
  const db = createDb(pool);
  const queues = createQueues(createQueueConnection(cfg.redis.url));
  // Auth counters are shared by every API task. A separate connection because
  // the updates connection below enters subscriber mode and cannot run INCR,
  // and a bounded retry policy so a Redis outage fails open instead of hanging
  // every login in the offline queue.
  const limiterRedis = new Redis(cfg.redis.url, {
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
  });

  // The GitHub App (decision #42) — app id + private key are deployment secrets.
  const githubApp =
    cfg.github.appId && cfg.github.privateKey
      ? createGitHubApp({
          appId: cfg.github.appId,
          privateKey: cfg.github.privateKey,
        })
      : undefined;
  // The bot identity comes from the App itself (GET /app): a renamed App
  // changes its slug, and a stale configured value silently misclassifies our
  // own comments and pushes as external (the WebRover #24 echo chain). The
  // env value remains the offline fallback.
  const resolvedSlug = githubApp ? await githubApp.appSlug() : undefined;
  const botLogin = resolvedSlug ? `${resolvedSlug}[bot]` : cfg.github.botLogin;

  // Live updates (steps 17b/18): the worker publishes "thread changed" nudges
  // and live run projections on Redis; this subscriber relays both to the SSE
  // clients in this process (nudge → refetch; live → chat stream).
  const hub = createStreamHub();
  const updates = createQueueConnection(cfg.redis.url);
  await Promise.all([
    updates.subscribe(UPDATES_CHANNEL),
    updates.subscribe(LIVE_CHANNEL),
  ]);
  updates.on("message", (channel: string, message: string) => {
    try {
      const parsed = JSON.parse(message) as { threadId?: unknown };
      if (typeof parsed.threadId !== "string") return;
      if (channel === LIVE_CHANNEL)
        hub.send(parsed.threadId, `event: live\ndata: ${message}\n\n`);
      else hub.notify(parsed.threadId);
    } catch {
      /* malformed message — ignore */
    }
  });

  // The image bakes the dashboard next to the server; `npm run dev` does not,
  // so the directory is optional and the check keeps dev from serving stale UI.
  const dashboardDir =
    cfg.paths.dashboardDist ??
    path.resolve(import.meta.dirname, "../../../dashboard/dist");
  const hasDashboard = existsSync(path.join(dashboardDir, "index.html"));

  const app = createServerApp({
    db,
    queues,
    webhookSecret: cfg.github.webhookSecret ?? "",
    botLogin,
    skipSignatureVerification: skipVerify,
    ...(githubApp ? { githubApp } : {}),
    authConfig: cfg.auth,
    authLimiters: {
      login: createRedisLimiter(limiterRedis, { limit: 10, windowMs: 5 * 60_000 }),
      signup: createRedisLimiter(limiterRedis, { limit: 5, windowMs: 60 * 60_000 }),
    },
    publicUrl: cfg.server.publicUrl,
    hub,
    ...(hasDashboard ? { dashboardDir } : {}),
    readyz: async () => {
      let database = false;
      let redis = false;
      try {
        await pool.query("select 1");
        database = true;
      } catch { /* reported below */ }
      try {
        await updates.ping();
        redis = true;
      } catch { /* reported below */ }
      return { ok: database && redis, checks: { database, redis } };
    },
    oauth: {
      ...(cfg.github.appSlug ? { slug: cfg.github.appSlug } : {}),
      ...(cfg.github.clientId ? { clientId: cfg.github.clientId } : {}),
      ...(cfg.github.clientSecret
        ? { clientSecret: cfg.github.clientSecret }
        : {}),
    },
  });

  const server = serve({ fetch: app.fetch, port: cfg.server.port });
  process.stdout.write(`sailor serve — listening on :${cfg.server.port}\n`);
  process.stdout.write(
    `  webhook  POST http://localhost:${cfg.server.port}/webhooks/github\n`,
  );
  process.stdout.write(
    `  health   GET  http://localhost:${cfg.server.port}/healthz  (ready: /readyz)\n`,
  );
  if (hasDashboard)
    process.stdout.write(
      `  ui       GET  http://localhost:${cfg.server.port}/  (${dashboardDir})\n`,
    );
  process.stdout.write(
    `  api      GET  http://localhost:${cfg.server.port}/api/threads (SSE: /api/threads/:id/stream)\n`,
  );
  if (skipVerify)
    process.stdout.write(
      "  ⚠ signature verification DISABLED (--no-verify)\n",
    );
  if (githubApp) {
    process.stdout.write(
      `  github   app id ${cfg.github.appId} — bot ${botLogin ?? "unknown (no slug resolved yet)"}\n`,
    );
  } else {
    process.stdout.write(
      "  github   no GitHub App configured — installs/PR delivery idle (set GITHUB_APP_*)\n",
    );
  }
  if (cfg.auth.devBypass)
    process.stdout.write(
      "  ⚠ DEV_AUTH_BYPASS — auth disabled (never in production)\n",
    );

  const shutdown = async () => {
    process.stdout.write("\nsailor serve — shutting down\n");
    server.close();
    updates.disconnect();
    limiterRedis.disconnect();
    await queues.close().catch(() => undefined);
    await pool.end().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  return new Promise<number>(() => undefined); // run until a signal arrives
}
