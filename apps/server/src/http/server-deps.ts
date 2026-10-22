import type { Db } from "../db/index.js";
import type { Queues } from "../queue/index.js";
import type { GitHubAppService } from "../services/github/app.js";
import type { AuthConfig } from "./routes/auth.js";
import type { StreamHub } from "./stream.js";
import type { Limiter } from "./rate-limit.js";

export interface ServerDeps {
  db: Db;
  queues: Queues;
  /** Required unless skipSignatureVerification (dev only). */
  webhookSecret: string;
  /** The bot's login — lets triage tag self-authored events. */
  botLogin?: string;
  /** Test/dev only (`sailor serve --no-verify`): accept unsigned bodies. */
  skipSignatureVerification?: boolean;
  log?: (line: string) => void;
  /** GitHub App service (decisions #42/#44) — onboarding + repo sync. */
  githubApp?: GitHubAppService;
  /** Sessions + dev affordances (decision #41). */
  authConfig?: AuthConfig;
  /** Dashboard base URL — browser-facing redirects land here. */
  publicUrl?: string;
  /** The App's user-OAuth credentials (Sign in with GitHub). */
  oauth?: {
    slug?: string;
    clientId?: string;
    clientSecret?: string;
    fetchFn?: typeof fetch;
  };
  /** Live-update fanout (step 17b): SSE clients get "thread changed" nudges. */
  hub?: StreamHub;
  /** Override the per-IP auth limiters (tests, or a Redis-backed limiter). */
  authLimiters?: { login?: Limiter; signup?: Limiter };
}

