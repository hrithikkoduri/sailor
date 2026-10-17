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
import { createGitHubClient } from "../github/client.js";
import { createServerApp } from "./app.js";

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
  const app = createServerApp({
    db,
    queues,
    webhookSecret: cfg.github.webhookSecret ?? "",
    botLogin: cfg.github.botLogin,
    skipSignatureVerification: skipVerify,
  });

  const server = serve({ fetch: app.fetch, port: cfg.server.port });
  process.stdout.write(`harness serve — listening on :${cfg.server.port}\n`);
  process.stdout.write(`  webhook  POST http://localhost:${cfg.server.port}/webhooks/github\n`);
  process.stdout.write(`  health   GET  http://localhost:${cfg.server.port}/healthz\n`);
  if (skipVerify) process.stdout.write("  ⚠ signature verification DISABLED (--no-verify)\n");
  if (cfg.github.token) {
    const who = await createGitHubClient({ token: cfg.github.token })
      .whoami()
      .catch(() => undefined);
    process.stdout.write(who ? `  github   authenticated as ${who.login} (${who.type})\n` : "  github   token rejected — check GITHUB_TOKEN\n");
  } else {
    process.stdout.write("  github   no GITHUB_TOKEN — PR delivery stays disabled until it is set\n");
  }

  const shutdown = async () => {
    process.stdout.write("\nharness serve — shutting down\n");
    server.close();
    await queues.close().catch(() => undefined);
    await pool.end().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  return new Promise<number>(() => undefined); // run until a signal arrives
}
