/**
 * Central configuration.
 *
 * Every setting the sailor reads from the environment lives here, in one typed
 * object. Nothing else in the codebase touches `process.env` directly — that way
 * "what knobs does this system have?" is answered by reading this file.
 *
 * Precedence: real environment variables win over `.env` file values (matching
 * how `node --env-file` behaves).
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { HeyoSizeClass } from "@anchor/core";

export interface SailorConfig {
  /** Optional delivery policy; never a conversational completion gate. */
  publication: { requirePassingTests: boolean };
  /** Heyo Cloud connection (Firecracker microVMs) — the only production sandbox. */
  heyo: {
    token: string | undefined;
    server: string;
    namespace: string;
    image: string;
    /** How `image` resolves: a prebuilt artifact, a store Dockerfile manifest, or a git source. */
    imageKind: "artifact" | "dockerfile" | "git";
    /** git kind: repo URL, ref, Dockerfile path, and the git-token secret. */
    imageRepo: string | undefined;
    imageRef: string | undefined;
    imageDockerfile: string | undefined;
    imageAuth: { secret: string; key?: string } | undefined;
    sizeClass: HeyoSizeClass;
    diskSizeGb: number;
  };
  /** GitHub App (decision #42) — replaces the PAT entirely. */
  github: {
    appId: string | undefined;
    appSlug: string | undefined;
    /** PEM (raw, \n-escaped, or base64) — a deployment secret, never in the DB. */
    privateKey: string | undefined;
    /** User-to-server OAuth for "Sign in with GitHub" (decision #41). */
    clientId: string | undefined;
    clientSecret: string | undefined;
    /** Webhook HMAC secret — configured ONCE on the App. */
    webhookSecret: string | undefined;
    /** Derived bot identity: {slug}[bot]. */
    botLogin: string | undefined;
  };
  /** Sessions + dev affordances (decision #41). */
  auth: {
    sessionTtlDays: number;
    secureCookies: boolean;
    /** DEV ONLY: skip auth for UI iteration; never honored in production. */
    devBypass: boolean;
  };
  /** Webhook server + dashboard links. */
  server: {
    port: number;
    /** Base URL of the dashboard — trace links in PRs point here. */
    publicUrl: string;
  };
  /** LLM endpoint — any OpenAI-compatible API (OpenRouter by default). */
  llm: {
    baseUrl: string;
    apiKey: string | undefined;
    model: string | undefined;
    /** USD per million tokens; enables cost accounting when both are set. */
    priceInPerMTok?: number;
    priceOutPerMTok?: number;
  };
  /**
   * Run budgets — long-horizon dials, cumulative per run. The engine ships
   * conservative package defaults; Sailor raises them because a realistic
   * issue-fix runs 100+ calls, and cumulative token use grows with every call
   * no matter how well compaction bounds the per-call context.
   */
  budget: {
    maxSteps: number;
    maxTokens: number;
    maxUsd: number;
    /** Budget revival (A): continue out-of-budget runs while the thread has budget. */
    revival: boolean;
  };
  /** Postgres — threads, runs, events, traces (full stack from step 2). */
  postgres: { url: string };
  /** Redis — BullMQ queues (runs + babysit timers). */
  redis: { url: string };
}

const SIZE_CLASSES: HeyoSizeClass[] = [
  "micro",
  "mini",
  "small",
  "medium",
  "large",
  "xlarge",
];

/**
 * Parse `.env` file contents: `KEY=value` lines, `#` comments, optional quotes.
 * Exported for tests.
 */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const withoutExport = line.startsWith("export ")
      ? line.slice("export ".length)
      : line;
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

/** Find the nearest .env: cwd first, then parents (monorepo-friendly). */
export function findDotEnv(
  startDir: string,
  maxLevels = 5,
): string | undefined {
  let dir = path.resolve(startDir);
  for (let i = 0; i <= maxLevels; i++) {
    const candidate = path.join(dir, ".env");
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/** Fill `target` from a .env file without overwriting anything already set. */
export function loadDotEnv(
  explicit?: string,
  target: NodeJS.ProcessEnv = process.env,
): void {
  const file = explicit ?? findDotEnv(process.cwd());
  if (!file) return; // no .env anywhere up the tree is fine — env vars may be set
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return;
  }
  for (const [key, value] of Object.entries(parseEnvFile(text))) {
    if (target[key] === undefined) target[key] = value;
  }
}

function sizeClass(value: string | undefined): HeyoSizeClass {
  const v = (value ?? "small") as HeyoSizeClass;
  if (!SIZE_CLASSES.includes(v)) {
    throw new Error(
      `HEYO_SIZE_CLASS must be one of ${SIZE_CLASSES.join(", ")} — got "${value}"`,
    );
  }
  return v;
}

/** PEM from env: raw, \n-escaped, or base64 of the PEM (tolerates stray
 *  paste artifacts like terminal markers, quotes, or whitespace). */
function normalizePem(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const value = raw.trim();
  if (value.includes("BEGIN")) return value.replace(/\\n/g, "\n");
  const decoded = Buffer.from(
    value.replace(/[^A-Za-z0-9+/=]/g, ""),
    "base64",
  ).toString("utf8");
  return decoded.includes("BEGIN") ? decoded : raw; // let the crypto layer complain loudly
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
export function loadConfig(env: NodeJS.ProcessEnv = process.env): SailorConfig {
  return {
    publication: {
      requirePassingTests: env.SAILOR_REQUIRE_PASSING_TESTS === "1",
    },
    heyo: {
      token: env.HEYO_TOKEN || undefined,
      server: env.HEYO_SERVER ?? "https://admin.us5.heyo.work",
      namespace: env.HEYO_NAMESPACE ?? "sailor",
      image: env.HEYO_IMAGE ?? "heyo/bun:latest",
      // artifact: pull a prebuilt rootfs from the store. dockerfile: a store
      // Dockerfile manifest the host builds. git: the host clones + builds
      // (private repos need HEYO_IMAGE_GIT_SECRET, an app-lb secret name).
      imageKind:
        env.HEYO_IMAGE_KIND === "git"
          ? "git"
          : env.HEYO_IMAGE_KIND === "dockerfile"
            ? "dockerfile"
            : "artifact",
      imageRepo: env.HEYO_IMAGE_GIT_REPO || undefined,
      imageRef: env.HEYO_IMAGE_GIT_REF || undefined,
      imageDockerfile: env.HEYO_IMAGE_GIT_DOCKERFILE || undefined,
      imageAuth: env.HEYO_IMAGE_GIT_SECRET
        ? {
            secret: env.HEYO_IMAGE_GIT_SECRET,
            ...(env.HEYO_IMAGE_GIT_SECRET_KEY
              ? { key: env.HEYO_IMAGE_GIT_SECRET_KEY }
              : {}),
          }
        : undefined,
      sizeClass: sizeClass(env.HEYO_SIZE_CLASS),
      diskSizeGb: Number(env.HEYO_DISK_GB ?? "4") || 4,
    },
    github: {
      appId: env.GITHUB_APP_ID || undefined,
      appSlug: env.GITHUB_APP_SLUG || undefined,
      privateKey: normalizePem(env.GITHUB_APP_PRIVATE_KEY),
      clientId: env.GITHUB_APP_CLIENT_ID || undefined,
      clientSecret: env.GITHUB_APP_CLIENT_SECRET || undefined,
      webhookSecret: env.GITHUB_WEBHOOK_SECRET || undefined,
      botLogin: env.GITHUB_APP_SLUG ? `${env.GITHUB_APP_SLUG}[bot]` : undefined,
    },
    auth: {
      sessionTtlDays: optionalNumber(env.SESSION_TTL_DAYS) ?? 30,
      secureCookies: (
        env.SAILOR_PUBLIC_URL ?? "http://localhost:5173"
      ).startsWith("https"),
      devBypass: env.DEV_AUTH_BYPASS === "1" && env.NODE_ENV !== "production",
    },
    server: {
      port: Number(env.SAILOR_PORT ?? "8787") || 8787,
      publicUrl: env.SAILOR_PUBLIC_URL ?? "http://localhost:5173",
    },
    llm: {
      baseUrl: env.LLM_BASE_URL ?? "https://openrouter.ai/api/v1",
      apiKey: env.LLM_API_KEY || undefined,
      model: env.LLM_MODEL || undefined,
      priceInPerMTok: optionalNumber(env.LLM_PRICE_IN_PER_MTOK),
      priceOutPerMTok: optionalNumber(env.LLM_PRICE_OUT_PER_MTOK),
    },
    budget: {
      // Per-RUN dials, defaulted for deepseek-v4.1-flash prices (~$0.04/M in,
      // ~$0.14/M out). On a pricier model the dollar cap binds first — set
      // SAILOR_MAX_USD deliberately before switching LLM_MODEL.
      //
      // $5 per run is deliberately a FRACTION of the thread's own budget
      // (threads.budgetMaxUsd, default $25): a run that hits its cap must
      // leave room for revivals, or the chain can never start.
      maxSteps: optionalNumber(env.SAILOR_MAX_STEPS) ?? 300,
      maxTokens: optionalNumber(env.SAILOR_MAX_TOKENS) ?? 150_000_000,
      maxUsd: optionalNumber(env.SAILOR_MAX_USD) ?? 5,
      /**
       * Budget revival: a run that ends out of budget with a handoff
       * (revival request and/or a checkpoint) continues on its own — same
       * task, same budget — until the THREAD's budget is spent.
       * SAILOR_BUDGET_REVIVAL=0 turns it off.
       */
      revival: env.SAILOR_BUDGET_REVIVAL !== "0",
    },
    postgres: {
      url: env.DATABASE_URL ?? "postgres://sailor:sailor@localhost:5432/sailor",
    },
    redis: { url: env.REDIS_URL ?? "redis://localhost:6379" },
  };
}
