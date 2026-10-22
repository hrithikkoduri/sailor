/**
 * Sailor's E2B wiring. E2B boots **templates**, not Docker images, so
 * `E2B_TEMPLATE` (or the task's image, when it names one) must point at a
 * template built with `Template().fromImage(...)` / `fromDockerfile(...)`.
 */
import type { SandboxProvider } from "anchor-ai-sdk";
import { e2b } from "anchor-ai-sdk/sandbox/e2b";
import type { SailorConfig } from "../config.js";

export function e2bProvider(cfg: SailorConfig): SandboxProvider {
  return e2b({
    ...(cfg.e2b.apiKey ? { apiKey: cfg.e2b.apiKey } : {}),
    template: cfg.e2b.template,
    ...(cfg.e2b.user ? { user: cfg.e2b.user } : {}),
    timeoutMs: cfg.e2b.timeoutMs,
    ...(cfg.e2b.domain ? { domain: cfg.e2b.domain } : {}),
  });
}
