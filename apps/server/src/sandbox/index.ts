/**
 * The ONE place Sailor picks a sandbox backend. Products own this choice;
 * Anchor owns the mechanics behind the `SandboxProvider` contract.
 */
import type { SandboxProvider } from "anchor-ai-sdk";
import { local } from "anchor-ai-sdk/sandbox/local";
import type { SailorConfig } from "../config.js";
import { e2bProvider } from "./e2b.js";
import { heyoProvider } from "./heyo.js";

/** The configured backend (`SAILOR_SANDBOX`, default heyo). */
export function sandboxProvider(cfg: SailorConfig): SandboxProvider {
  return cfg.sandbox === "e2b" ? e2bProvider(cfg) : heyoProvider(cfg);
}

/**
 * The backend a retained thread was created on. Adoption must use the same
 * one, or a resume lands on a different machine than the work.
 */
export function providerForBackend(
  backend: string | null | undefined,
  cfg: SailorConfig,
): SandboxProvider {
  if (backend === "local") return local();
  if (backend === "e2b") return e2bProvider(cfg);
  return heyoProvider(cfg);
}
