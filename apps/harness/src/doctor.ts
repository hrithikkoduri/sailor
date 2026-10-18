/**
 * `harness doctor` — pre-flight checklist for the whole system.
 *
 * Every external dependency the harness needs is one check here. A red line
 * with a hint beats a mysterious crash three steps later. This file doubles as
 * the map of the system's dependencies: if we add one, it gets a check.
 */
import { spawnSync } from "node:child_process";
import { Pool } from "pg";
import { Redis } from "ioredis";
import { Hws } from "@heyocomputer/hws";
import type { HarnessConfig } from "./config.js";

export type CheckStatus = "ok" | "warn" | "fail";

export interface CheckResult {
  /** What we checked, e.g. "Postgres". */
  name: string;
  status: CheckStatus;
  /** What we found, e.g. "reachable at localhost:5432". */
  detail: string;
  /** How to fix a non-ok result. */
  hint?: string;
  /** Required checks failing means exit code 1 (setup incomplete). */
  required: boolean;
}

/** Real Postgres probe: connect and SELECT 1 (not just "is the port open"). */
async function pgProbe(url: string, timeoutMs = 2000): Promise<boolean> {
  const pool = new Pool({ connectionString: url, connectionTimeoutMillis: timeoutMs, max: 1 });
  try {
    await pool.query("SELECT 1");
    return true;
  } catch {
    return false;
  } finally {
    await pool.end().catch(() => undefined);
  }
}

/** Real Redis probe: connect and PING. */
async function redisProbe(url: string, timeoutMs = 2000): Promise<boolean> {
  const client = new Redis(url, {
    lazyConnect: true,
    connectTimeout: timeoutMs,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null, // fail fast instead of reconnecting forever
  });
  try {
    await client.connect();
    return (await client.ping()) === "PONG";
  } catch {
    return false;
  } finally {
    client.disconnect();
  }
}

function commandAvailable(cmd: string): string | null {
  // Look beyond PATH too: on macOS the docker CLI often lives in /usr/local/bin
  // or inside Docker Desktop.app without being linked into the shell's PATH.
  const candidates = [
    cmd,
    `/usr/local/bin/${cmd}`,
    `/opt/homebrew/bin/${cmd}`,
    `/Applications/Docker.app/Contents/Resources/bin/${cmd}`,
  ];
  for (const candidate of candidates) {
    const r = spawnSync(candidate, ["--version"], { timeout: 3000, encoding: "utf8" });
    if (r.status === 0) return (r.stdout ?? "").trim().split("\n")[0] ?? null;
  }
  return null;
}

/** Live Heyo credential probe: does the token work, and what can it see? */
async function heyoProbe(
  server: string,
  token: string,
): Promise<{ ok: true; namespace?: string; admin?: string; deployments?: number } | { ok: false; error: string }> {
  const lb = new Hws({ server, token, timeoutMs: 10_000 });
  try {
    const who = await lb.whoami();
    let deployments: number | undefined;
    try {
      deployments = (await lb.deployments()).length;
    } catch {
      deployments = undefined; // token may lack list rights; whoami is the check
    }
    return { ok: true, namespace: who.namespace, admin: who.admin_scope, deployments };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message.split("\n")[0] ?? message };
  }
}

export async function runDoctor(cfg: HarnessConfig): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  // --- runtime -------------------------------------------------------------
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  results.push({
    name: "Node.js",
    status: nodeMajor >= 20 ? "ok" : "fail",
    detail: `v${process.versions.node}`,
    hint: nodeMajor >= 20 ? undefined : "The harness needs Node.js 20 or newer.",
    required: true,
  });

  // --- host tools ----------------------------------------------------------
  const git = commandAvailable("git");
  results.push({
    name: "git",
    status: git ? "ok" : "fail",
    detail: git ?? "not found",
    hint: git ? undefined : "Install git — sandboxes clone repos and checkpoint with it.",
    required: true,
  });

  // Docker is optional: it runs the local Postgres+Redis stack (docker compose up)
  // and later builds VM toolchain images. Warn, never fail.
  const docker = commandAvailable("docker");
  results.push({
    name: "docker",
    status: docker ? "ok" : "warn",
    detail: docker ?? "not installed",
    hint: docker
      ? undefined
      : "Optional, but it runs the local Postgres+Redis stack: docker compose up -d",
    required: false,
  });

  // --- full stack: Postgres + Redis ----------------------------------------
  const pgUp = await pgProbe(cfg.postgres.url);
  results.push({
    name: "Postgres",
    status: pgUp ? "ok" : "fail",
    detail: pgUp ? `connected (${cfg.postgres.url})` : `cannot connect (${cfg.postgres.url})`,
    hint: pgUp ? undefined : "Start the stack: docker compose up -d  (see BUILD_PLAN.md step 2)",
    required: true,
  });

  const redisUp = await redisProbe(cfg.redis.url);
  results.push({
    name: "Redis",
    status: redisUp ? "ok" : "fail",
    detail: redisUp ? `connected (${cfg.redis.url})` : `cannot connect (${cfg.redis.url})`,
    hint: redisUp ? undefined : "Start the stack: docker compose up -d  (see BUILD_PLAN.md step 2)",
    required: true,
  });

  // --- credentials ----------------------------------------------------------
  // HEYO_TOKEN gets a LIVE probe: presence alone hides the classic failures
  // (expired token, wrong server, token confined to a different namespace).
  if (cfg.heyo.token) {
    const probe = await heyoProbe(cfg.heyo.server, cfg.heyo.token);
    if (probe.ok) {
      const mismatch = probe.namespace !== undefined && probe.namespace !== cfg.heyo.namespace;
      const vms = probe.deployments !== undefined ? `, ${probe.deployments} deployment(s) alive` : "";
      results.push({
        name: "HEYO_TOKEN",
        status: mismatch ? "fail" : "ok",
        detail: mismatch
          ? `valid, but confined to namespace "${probe.namespace}" while HEYO_NAMESPACE is "${cfg.heyo.namespace}"`
          : `valid — namespace ${probe.namespace ?? "(unconfined)"}, ${probe.admin ?? "?"} tier${vms}`,
        hint: mismatch
          ? "Align HEYO_NAMESPACE with the token's namespace, or mint a token for it."
          : probe.deployments
            ? "Deployments alive — sandboxes from a run are still billing. Delete with heyctl or the console."
            : undefined,
        required: false,
      });
    } else {
      results.push({
        name: "HEYO_TOKEN",
        status: "fail",
        detail: `set but rejected: ${probe.error}`,
        hint: "Check HEYO_TOKEN and HEYO_SERVER, or mint a fresh token in the namespace dashboard.",
        required: false,
      });
    }
  } else {
    results.push({
      name: "HEYO_TOKEN",
      status: "warn",
      detail: "not set — microVM backend unavailable",
      hint: "Needed for the heyo sandbox backend; get one from your namespace dashboard at app.heyo.computer.",
      required: false,
    });
  }

  results.push({
    name: "LLM_API_KEY",
    status: cfg.llm.apiKey ? "ok" : "warn",
    detail: cfg.llm.apiKey ? `set (${cfg.llm.baseUrl})` : "not set — agent runs unavailable",
    hint: cfg.llm.apiKey ? undefined : "Needed to run the agent (step 7). Get one at openrouter.ai.",
    required: false,
  });

  results.push({
    name: "GITHUB_APP",
    status: cfg.github.appId && cfg.github.privateKey ? "ok" : "warn",
    detail:
      cfg.github.appId && cfg.github.privateKey
        ? `app id ${cfg.github.appId}${cfg.github.appSlug ? ` (${cfg.github.appSlug})` : ""}`
        : "not configured — installs / PR delivery unavailable",
    hint:
      cfg.github.appId && cfg.github.privateKey
        ? undefined
        : "Create a GitHub App (decision #42) and set GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY (+ SLUG / CLIENT_ID / CLIENT_SECRET).",
    required: false,
  });

  results.push({
    name: "GITHUB_WEBHOOK_SECRET",
    status: cfg.github.webhookSecret ? "ok" : "warn",
    detail: cfg.github.webhookSecret ? "set" : "not set — `harness serve` refuses to start",
    hint: cfg.github.webhookSecret ? undefined : "Configure the webhook secret on the GitHub App; put it in .env.",
    required: false,
  });

  return results;
}

// --- rendering -------------------------------------------------------------

const ICONS: Record<CheckStatus, string> = { ok: "✓", warn: "⚠", fail: "✗" };
const COLORS: Record<CheckStatus, string> = { ok: "32", warn: "33", fail: "31" };

function paint(status: CheckStatus, text: string): string {
  return process.stdout.isTTY ? `\x1b[${COLORS[status]}m${text}\x1b[0m` : text;
}

export function renderDoctor(results: CheckResult[]): string {
  const lines: string[] = ["Harness environment check", ""];
  const nameWidth = Math.max(...results.map((r) => r.name.length));
  for (const r of results) {
    lines.push(`  ${paint(r.status, ICONS[r.status])}  ${r.name.padEnd(nameWidth)}  ${r.detail}`);
    if (r.hint && r.status !== "ok") {
      lines.push(`      ${" ".repeat(nameWidth)}  → ${r.hint}`);
    }
  }
  const failed = results.filter((r) => r.required && r.status === "fail").length;
  const warned = results.filter((r) => r.status === "warn").length;
  lines.push("");
  lines.push(
    failed > 0
      ? `  ${failed} required check(s) failing — setup incomplete.`
      : `  All required checks pass.${warned > 0 ? ` (${warned} warning(s))` : ""}`,
  );
  return lines.join("\n");
}

/** True when every required check passed. */
export function doctorPassed(results: CheckResult[]): boolean {
  return !results.some((r) => r.required && r.status === "fail");
}
