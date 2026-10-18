/**
 * `harness serve` — the long-lived webhook intake service.
 *
 * Writes Postgres + the queue only: a labeled issue becomes a thread and a
 * queued run; the worker (separate process, same DB) executes it.
 */
import { serve } from "@hono/node-server";
import { loadConfig } from "../config.js";
import { createDb, createPool } from "../db/index.js";
import { createQueueConnection, createQueues } from "../queue/index.js";
import { createGitHubApp } from "../github/app.js";
import { createServerApp } from "./app.js";
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

  // The GitHub App (decision #42) — app id + private key are deployment secrets.
  const githubApp =
    cfg.github.appId && cfg.github.privateKey
      ? createGitHubApp({ appId: cfg.github.appId, privateKey: cfg.github.privateKey })
      : undefined;

  // Live updates (steps 17b/18): the worker publishes "thread changed" nudges
  // and live run projections on Redis; this subscriber relays both to the SSE
  // clients in this process (nudge → refetch; live → chat stream).
  const hub = createStreamHub();
  const updates = createQueueConnection(cfg.redis.url);
  await Promise.all([updates.subscribe(UPDATES_CHANNEL), updates.subscribe(LIVE_CHANNEL)]);
  updates.on("message", (channel: string, message: string) => {
    try {
      const parsed = JSON.parse(message) as { threadId?: unknown };
      if (typeof parsed.threadId !== "string") return;
      if (channel === LIVE_CHANNEL) hub.send(parsed.threadId, `event: live\ndata: ${message}\n\n`);
      else hub.notify(parsed.threadId);
    } catch {
      /* malformed message — ignore */
    }
  });

  const app = createServerApp({
    db,
    queues,
    webhookSecret: cfg.github.webhookSecret ?? "",
    botLogin: cfg.github.botLogin,
    skipSignatureVerification: skipVerify,
    ...(githubApp ? { githubApp } : {}),
    authConfig: cfg.auth,
    publicUrl: cfg.server.publicUrl,
    hub,
    oauth: {
      ...(cfg.github.appSlug ? { slug: cfg.github.appSlug } : {}),
      ...(cfg.github.clientId ? { clientId: cfg.github.clientId } : {}),
      ...(cfg.github.clientSecret ? { clientSecret: cfg.github.clientSecret } : {}),
    },
  });

  const server = serve({ fetch: app.fetch, port: cfg.server.port });
  process.stdout.write(`harness serve — listening on :${cfg.server.port}\n`);
  process.stdout.write(`  webhook  POST http://localhost:${cfg.server.port}/webhooks/github\n`);
  process.stdout.write(`  health   GET  http://localhost:${cfg.server.port}/healthz\n`);
  process.stdout.write(`  api      GET  http://localhost:${cfg.server.port}/api/threads (SSE: /api/threads/:id/stream)\n`);
  if (skipVerify) process.stdout.write("  ⚠ signature verification DISABLED (--no-verify)\n");
  if (githubApp) {
    process.stdout.write(
      `  github   app id ${cfg.github.appId}${cfg.github.appSlug ? ` (${cfg.github.appSlug})` : ""}\n`,
    );
  } else {
    process.stdout.write("  github   no GitHub App configured — installs/PR delivery idle (set GITHUB_APP_*)\n");
  }
  if (cfg.auth.devBypass) process.stdout.write("  ⚠ DEV_AUTH_BYPASS — auth disabled (never in production)\n");

  const shutdown = async () => {
    process.stdout.write("\nharness serve — shutting down\n");
    server.close();
    updates.disconnect();
    await queues.close().catch(() => undefined);
    await pool.end().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  return new Promise<number>(() => undefined); // run until a signal arrives
}
