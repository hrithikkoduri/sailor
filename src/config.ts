/**
 * Central configuration.
 *
 * Every setting the harness reads from the environment lives here, in one typed
 * object. Nothing else in the codebase touches `process.env` directly — that way
 * "what knobs does this system have?" is answered by reading this file.
 *
 * Precedence: real environment variables win over `.env` file values (matching
 * how `node --env-file` behaves).
 */
import { readFileSync } from "node:fs";

export type HeyoSizeClass = "micro" | "mini" | "small" | "medium" | "large" | "xlarge";

export interface HarnessConfig {
  /** Heyo Cloud connection (Firecracker microVMs) — the only production sandbox. */
  heyo: {
    token: string | undefined;
    server: string;
    namespace: string;
    image: string;
    sizeClass: HeyoSizeClass;
    diskSizeGb: number;
  };
  /** GitHub access for reading issues and opening PRs (bot account PAT). */
  github: { token: string | undefined };
  /** LLM endpoint — any OpenAI-compatible API (OpenRouter by default). */
  llm: {
    baseUrl: string;
    apiKey: string | undefined;
    model: string | undefined;
    /** USD per million tokens; enables cost accounting when both are set. */
    priceInPerMTok?: number;
    priceOutPerMTok?: number;
  };
  /** Postgres — threads, runs, events, traces (full stack from step 2). */
  postgres: { url: string };
  /** Redis — BullMQ queues (runs + babysit timers). */
  redis: { url: string };
}

const SIZE_CLASSES: HeyoSizeClass[] = ["micro", "mini", "small", "medium", "large", "xlarge"];

/**
 * Parse `.env` file contents: `KEY=value` lines, `#` comments, optional quotes.
 * Exported for tests.
 */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const withoutExport = line.startsWith("export ") ? line.slice("export ".length) : line;
    const eq = withoutExport.indexOf("=");
    if (eq <= 0) continue;
    const key = withoutExport.slice(0, eq).trim();
    let value = withoutExport.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/** Fill `target` from a .env file without overwriting anything already set. */
export function loadDotEnv(path = ".env", target: NodeJS.ProcessEnv = process.env): void {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return; // no .env file is fine — real env vars may be set already
  }
  for (const [key, value] of Object.entries(parseEnvFile(text))) {
    if (target[key] === undefined) target[key] = value;
  }
}

function sizeClass(value: string | undefined): HeyoSizeClass {
  const v = (value ?? "small") as HeyoSizeClass;
  if (!SIZE_CLASSES.includes(v)) {
    throw new Error(`HEYO_SIZE_CLASS must be one of ${SIZE_CLASSES.join(", ")} — got "${value}"`);
  }
  return v;
}

function optionalNumber(value: string | undefined): number | undefined {
  if (value === undefined || value === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Build the typed config from an environment map. Pure: no file access, no
 * mutation — tests can pass a plain object.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): HarnessConfig {
  return {
    heyo: {
      token: env.HEYO_TOKEN || undefined,
      server: env.HEYO_SERVER ?? "https://admin.us5.heyo.work",
      namespace: env.HEYO_NAMESPACE ?? "harness",
      image: env.HEYO_IMAGE ?? "heyo/bun:latest",
      sizeClass: sizeClass(env.HEYO_SIZE_CLASS),
      diskSizeGb: Number(env.HEYO_DISK_GB ?? "4") || 4,
    },
    github: { token: env.GITHUB_TOKEN || undefined },
    llm: {
      baseUrl: env.LLM_BASE_URL ?? "https://openrouter.ai/api/v1",
      apiKey: env.LLM_API_KEY || undefined,
      model: env.LLM_MODEL || undefined,
      priceInPerMTok: optionalNumber(env.LLM_PRICE_IN_PER_MTOK),
      priceOutPerMTok: optionalNumber(env.LLM_PRICE_OUT_PER_MTOK),
    },
    postgres: { url: env.DATABASE_URL ?? "postgres://harness:harness@localhost:5432/harness" },
    redis: { url: env.REDIS_URL ?? "redis://localhost:6379" },
  };
}
