import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import {
  configuredSandboxProvider,
  providerForBackend,
} from "../../src/sandbox-provider.js";

describe("sandbox provider selection", () => {
  it("uses the configured provider for new runs", () => {
    const e2b = loadConfig({
      SAILOR_SANDBOX_PROVIDER: "e2b",
      E2B_TEMPLATE: "anchor-sailor-toolchain:latest",
    });
    expect(configuredSandboxProvider(e2b).name).toBe("e2b");

    const local = loadConfig({ SAILOR_SANDBOX_PROVIDER: "local" });
    expect(configuredSandboxProvider(local).name).toBe("local");
  });

  it("uses the handle's backend for cleanup, never the current config", () => {
    const cfg = loadConfig({ SAILOR_SANDBOX_PROVIDER: "heyo" });
    expect(providerForBackend("e2b", cfg).name).toBe("e2b");
    expect(providerForBackend("local", cfg).name).toBe("local");
    expect(providerForBackend("heyo", cfg).name).toBe("heyo");
  });

  it("falls back to the configured provider for an unknown backend", () => {
    const cfg = loadConfig({ SAILOR_SANDBOX_PROVIDER: "e2b" });
    expect(providerForBackend(undefined, cfg).name).toBe("e2b");
  });
});
