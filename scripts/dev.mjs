#!/usr/bin/env node
/**
 * `npm run dev` — the complete stack, one command.
 *
 *   1. Postgres + Redis via docker compose (idempotent)
 *   2. migrations (idempotent)
 *   3. serve + worker + dashboard side by side, prefixed output
 *
 * Ctrl-C stops all three. ngrok (the webhook tunnel) is separate by design —
 * it's account-owned infrastructure, and the URL is configured on the App.
 */
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import process from "node:process";

const root = fileURLToPath(new URL("..", import.meta.url));

const COLORS = { serve: "\x1b[36m", worker: "\x1b[35m", web: "\x1b[32m", stack: "\x1b[90m" };
const RESET = "\x1b[0m";

const log = (name, text) => {
  for (const line of String(text).split("\n").filter((l) => l.trim().length > 0)) {
    process.stdout.write(`${COLORS[name] ?? ""}[${name}]${RESET} ${line}\n`);
  }
};

// --- 1. infra ------------------------------------------------------------------

log("stack", "docker compose up -d (Postgres + Redis)");
const compose = spawnSync("docker", ["compose", "up", "-d"], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
if (compose.status !== 0) {
  log("stack", `docker compose failed (exit ${compose.status}) — is Docker running?`);
  log("stack", String(compose.stderr));
  process.exit(1);
}

// --- 2. migrations ----------------------------------------------------------------

log("stack", "applying migrations");
const migrate = spawnSync("npm", ["run", "migrate"], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
if (migrate.status !== 0) {
  log("stack", `migrate failed (exit ${migrate.status})`);
  log("stack", String(migrate.stderr));
  process.exit(1);
}
log("stack", String(migrate.stdout).trim().split("\n").pop() ?? "migrations ok");

// --- 3. the three long-lived processes ---------------------------------------------

const children = [];
function start(name, args) {
  const child = spawn("npm", args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (d) => log(name, d));
  child.stderr.on("data", (d) => log(name, d));
  child.on("exit", (code) => log(name, `exited (code ${code})`));
  children.push(child);
  return child;
}

start("serve", ["run", "harness", "--", "serve"]);
start("worker", ["run", "harness", "--", "worker"]);
start("web", ["run", "dev", "-w", "apps/dashboard"]);

log("stack", "dashboard → http://localhost:5173  ·  webhooks → :8787 (tunnel: ngrok)");

let shuttingDown = false;
const shutdown = (signal) => {
  if (shuttingDown) return;
  shuttingDown = true;
  log("stack", `${signal} — stopping serve / worker / dashboard`);
  for (const child of children) child.kill("SIGTERM");
  setTimeout(() => process.exit(0), 1_500);
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
