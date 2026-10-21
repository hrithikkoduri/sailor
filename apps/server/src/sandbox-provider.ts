/**
 * The ONE place Sailor picks a sandbox backend. Products own this choice;
 * Anchor owns the mechanics behind the `SandboxProvider` contract.
 */
import type { SandboxProvider } from "anchor-ai-sdk";
import { local } from "anchor-ai-sdk/sandbox/local";
import type { SailorConfig } from "./config.js";
import { daytonaProvider } from "./daytona-provider.js";
import { e2bProvider } from "./e2b-provider.js";
import { heyoProvider } from "./heyo-provider.js";

/** The configured backend (`SAILOR_SANDBOX`, default heyo). */
export function sandboxProvider(cfg: SailorConfig): SandboxProvider {
  switch (cfg.sandbox) {
    case "e2b":
      return e2bProvider(cfg);
    case "daytona":
      return daytonaProvider(cfg);
    default:
      return heyoProvider(cfg);
  }
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
  if (backend === "daytona") return daytonaProvider(cfg);
  return heyoProvider(cfg);
}
