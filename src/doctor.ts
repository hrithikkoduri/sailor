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

  // --- credentials (optional until the feature that needs them lands) -------
  results.push({
    name: "HEYO_TOKEN",
    status: cfg.heyo.token ? "ok" : "warn",
    detail: cfg.heyo.token ? "set" : "not set — microVM backend unavailable",
    hint: cfg.heyo.token
      ? undefined
      : "Needed for the heyo sandbox backend (step 4). Dev runs fine on the process backend.",
    required: false,
  });

  results.push({
    name: "LLM_API_KEY",
    status: cfg.llm.apiKey ? "ok" : "warn",
    detail: cfg.llm.apiKey ? `set (${cfg.llm.baseUrl})` : "not set — agent runs unavailable",
    hint: cfg.llm.apiKey ? undefined : "Needed to run the agent (step 7). Get one at openrouter.ai.",
    required: false,
  });

  results.push({
    name: "GITHUB_TOKEN",
    status: cfg.github.token ? "ok" : "warn",
    detail: cfg.github.token ? "set" : "not set — issue fetch / PR creation unavailable",
    hint: cfg.github.token
      ? undefined
      : "Needed for GitHub integration (step 12): fine-grained PAT on the bot account.",
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
