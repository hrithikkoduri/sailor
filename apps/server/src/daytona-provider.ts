/**
 * Sailor's Daytona wiring. Daytona boots **snapshots**, so `DAYTONA_IMAGE`
 * (or the task's image, when it names one) must point at a snapshot built
 * with the agent toolchain — docs/daytona.md is the end-to-end guide.
 *
 * NOTE: anchor-ai-sdk's Daytona adapter is a stub in 0.1.x — it throws
 * "coming soon" and the `./sandbox/daytona` subpath is not in the package's
 * exports map yet, so this provider cannot call it the way e2b-provider /
 * heyo-provider do. Instead it fails loudly with a pointer to the guide, so
 * `SAILOR_SANDBOX=daytona` degrades to a clear setup error rather than a
 * resolver crash or a silent fall-back to heyo. When the SDK ships the
 * adapter, replace the throw with the mirror of e2b-provider.ts:
 *
 *   import { daytona } from "anchor-ai-sdk/sandbox/daytona";
 *   return daytona({ ...(cfg.daytona.apiKey ? { apiKey } : {}), image });
 */
import type { SandboxProvider } from "anchor-ai-sdk";
import type { SailorConfig } from "./config.js";

export function daytonaProvider(_cfg: SailorConfig): SandboxProvider {
  throw new Error(
    "the daytona sandbox backend is wired but inactive: anchor-ai-sdk's " +
      "daytona adapter is a stub (\"coming soon\") and not exported in " +
      "0.1.x — see docs/daytona.md for the activation checklist",
  );
}
