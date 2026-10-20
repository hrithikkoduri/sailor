/**
 * Sailor's E2B provider factory. The provider mechanics live in Anchor; this
 * is the one place Sailor translates its config into the E2B adapter options.
 */
import type { SandboxProvider } from "anchor-ai-sdk";
import { e2b } from "anchor-ai-sdk/sandbox/e2b";
import type { SailorConfig } from "./config.js";

export function e2bProvider(cfg: SailorConfig): SandboxProvider {
  return e2b({
    ...(cfg.sandbox.e2b.apiKey ? { apiKey: cfg.sandbox.e2b.apiKey } : {}),
    ...(cfg.sandbox.e2b.domain ? { domain: cfg.sandbox.e2b.domain } : {}),
    template: cfg.sandbox.e2b.template,
    ...(cfg.sandbox.e2b.user ? { user: cfg.sandbox.e2b.user } : {}),
    timeoutMs: cfg.sandbox.e2b.timeoutMs,
  });
}
