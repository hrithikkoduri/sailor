#!/usr/bin/env node
/**
 * `npm run dev` — the complete stack, one command.
 *
 *   1. Postgres + Redis: reachable already? proceed. Not reachable? compose up -d.
 *   2. migrations (idempotent)
 *   3. serve + worker + dashboard side by side, prefixed output
 *
 * Ctrl-C stops all three. ngrok (the webhook tunnel) is separate by design —
 * it's account-owned infrastructure, and the URL is configured on the App.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import net from "node:net";
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

/** Something accepting TCP on host:port right now? (the only truth that matters) */
function portOpen(host, port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const finish = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

const servicesUp = async () => (await portOpen("127.0.0.1", 5432)) && (await portOpen("127.0.0.1", 6379));

if (await servicesUp()) {
  log("stack", "Postgres + Redis already reachable — skipping docker compose");
} else {
  // The CLI may live outside PATH (OrbStack symlinks, Docker Desktop, brew).
  const candidates = [
    "docker",
    "/usr/local/bin/docker",
    "/opt/homebrew/bin/docker",
    "/Applications/Docker.app/Contents/Resources/bin/docker",
  ];
  let dockerBin;
  for (const candidate of candidates) {
    if (candidate.includes("/") && !existsSync(candidate)) continue;
    const probe = spawnSync(candidate, ["--version"], { stdio: "ignore" });
    if (!probe.error && probe.status === 0) {
      dockerBin = candidate;
      break;
    }
  }

  if (dockerBin) {
    log("stack", `starting Postgres + Redis (${dockerBin} compose up -d)`);
    const compose = spawnSync(dockerBin, ["compose", "up", "-d"], { cwd: root, encoding: "utf8" });
    if (compose.status !== 0) {
      const detail = compose.error
        ? `${compose.error.code ?? ""} ${compose.error.message}`.trim()
        : (compose.stderr || compose.stdout || "no output").trim();
      log("stack", `compose reported: ${detail.split("\n").slice(0, 3).join(" / ").slice(0, 400)}`);
    }
  } else {
    log("stack", "no docker CLI found — waiting for services to appear on their own");
  }

  // Containers take a moment to accept connections; give them up to ~20s.
  let ready = false;
  for (let i = 0; i < 20 && !ready; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    ready = await servicesUp();
  }
  if (!ready) {
    log("stack", "Postgres (:5432) and/or Redis (:6379) are not reachable.");
    log("stack", "Start OrbStack / Docker Desktop, or fix `docker` on PATH, then re-run `npm run dev`.");
    process.exit(1);
  }
  log("stack", "Postgres + Redis up");
}

// --- 2. migrations ----------------------------------------------------------------

log("stack", "applying migrations");
const migrate = spawnSync("npm", ["run", "migrate"], { cwd: root, encoding: "utf8" });
if (migrate.status !== 0) {
  const detail = migrate.error ? migrate.error.message : (migrate.stderr || migrate.stdout || "no output");
  log("stack", `migrate failed: ${detail.split("\n").slice(0, 4).join(" / ").slice(0, 400)}`);
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
