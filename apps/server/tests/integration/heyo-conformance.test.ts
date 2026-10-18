/**
 * Live provider conformance on real microVMs — paid infrastructure, opt-in:
 *
 *   RUN_LIVE_HEYO_TESTS=1 npm run test:integration -w apps/server -- heyo-conformance
 *
 * Optionally set ANCHOR_CONFORMANCE_REPO=<cloneable git URL> to include the
 * clone-shaped scenarios (they need a repo the VM can fetch). Each scenario
 * boots its own sandbox and destroys it — ~a minute each, hence the gate.
 */
import { describe } from "vitest";
import { runSandboxConformance } from "@anchor/core/testing";
import { loadConfig, loadDotEnv } from "../../src/config.js";
import { heyoProvider } from "../../src/heyo-provider.js";

const live = process.env.RUN_LIVE_HEYO_TESTS === "1";
if (live) loadDotEnv();
const cfg = loadConfig();

const hasToken = Boolean(cfg.heyo.token);
const repoUrl = process.env.ANCHOR_CONFORMANCE_REPO;

describe.skipIf(!live || !hasToken)("heyo sandbox conformance (live)", () => {
  runSandboxConformance(heyoProvider(cfg), {
    timeoutMs: 240_000,
    ...(repoUrl ? { repo: { repoUrl } } : {}),
  });
});
