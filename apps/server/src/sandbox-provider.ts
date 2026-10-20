/**
 * The provider seam, in one place: config → provider for a new run, and
 * handle backend → provider for releasing/cleaning up a retained sandbox.
 *
 * Sailor owns the policy (which backend, which template); Anchor owns the
 * mechanics. Adding a backend means one branch here, not a search across the
 * worker, CLI, and doctor.
 */
import type { SandboxProvider } from "anchor-ai-sdk";
import { local } from "anchor-ai-sdk/sandbox/local";
import type { SailorConfig } from "./config.js";
import { e2bProvider } from "./e2b-provider.js";
import { heyoProvider } from "./heyo-provider.js";

/** The provider new runs should use, from `SAILOR_SANDBOX_PROVIDER`. */
export function configuredSandboxProvider(
  cfg: SailorConfig,
): SandboxProvider {
  switch (cfg.sandbox.provider) {
    case "e2b":
      return e2bProvider(cfg);
    case "local":
      return local();
    case "heyo":
      return heyoProvider(cfg);
  }
}

/**
 * The provider that owns a retained handle. A thread's backend is stored
 * verbatim, so cleanup always uses the backend that created the sandbox —
 * never the current config, which may have moved on.
 */
export function providerForBackend(
  backend: string | null | undefined,
  cfg: SailorConfig,
): SandboxProvider {
  if (backend === "e2b") return e2bProvider(cfg);
  if (backend === "local") return local();
  if (backend === "heyo") return heyoProvider(cfg);
  return configuredSandboxProvider(cfg);
}
