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
import { existsSync, writeFileSync } from "node:fs";
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

start("serve", ["run", "serve:watch", "-w", "apps/server"]);
start("worker", ["run", "worker:watch", "-w", "apps/server"]);
start("web", ["run", "dev", "-w", "apps/dashboard"]);

// --- 4. optional public tunnel (ngrok) -------------------------------------------
// GitHub needs a public HTTPS URL for webhooks. Starting it here means the URL
// is printed with the rest of the stack instead of a second terminal — and the
// URL is written to .tunnel-url for scripts that need it.
const tunnelEnabled =
  process.env.SAILOR_TUNNEL === "1" || !!process.env.NGROK_AUTHTOKEN;

async function publicUrl() {
  try {
    const res = await fetch("http://127.0.0.1:4040/api/tunnels");
    if (!res.ok) return undefined;
    const data = await res.json();
    return data.tunnels?.find((t) => t.public_url?.startsWith("https://"))?.public_url;
  } catch {
    return undefined;
  }
}

async function startTunnel() {
  if (!tunnelEnabled) {
    log("tunnel", "off (set SAILOR_TUNNEL=1 to expose webhooks with ngrok)");
    return;
  }
  const child = spawn("ngrok", ["http", "8787", "--log", "stdout"], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.on("error", () => log("tunnel", "ngrok not found — install it or unset SAILOR_TUNNEL"));
  child.on("exit", (code) => log("tunnel", `exited (code ${code})`));
  children.push(child);

  for (let i = 0; i < 20; i++) {
    const url = await publicUrl();
    if (url) {
      writeFileSync(`${root}.tunnel-url`, `${url}\n`);
      log("tunnel", `public → ${url}`);
      log("tunnel", `set the GitHub App webhook to ${url}/webhooks/github`);
      return;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  log("tunnel", "ngrok started but no public URL appeared (is :4040 in use?)");
}

void startTunnel();

log("stack", "dashboard → http://localhost:5173  ·  webhooks → :8787");
log("stack", "watch mode: edits restart serve + worker (a worker restart mid-run = the sweep resumes it)");

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
