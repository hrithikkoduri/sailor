import { describe, expect, it } from "vitest";
import { loadConfig, parseEnvFile } from "../../src/config.js";

describe("parseEnvFile", () => {
  it("parses KEY=value lines and ignores comments/blank lines", () => {
    const parsed = parseEnvFile(
      ["# a comment", "", "A=1", "B=hello world", "export C=3", "not a pair"].join("\n"),
    );
    expect(parsed).toEqual({ A: "1", B: "hello world", C: "3" });
  });

  it("strips matching quotes from values", () => {
    expect(parseEnvFile(`A="quoted"\nB='single'\nC=keep"inner"`)).toEqual({
      A: "quoted",
      B: "single",
      C: `keep"inner"`,
    });
  });
});

describe("loadConfig", () => {
  it("has sane defaults when the environment is empty", () => {
    const cfg = loadConfig({});
    expect(cfg.sandbox.provider).toBe("heyo");
    expect(cfg.sandbox.e2b.template).toBe("anchor-sailor-toolchain:latest");
    expect(cfg.sandbox.e2b.timeoutMs).toBe(3_600_000);
    expect(cfg.heyo.server).toBe("https://admin.us5.heyo.work");
    expect(cfg.heyo.sizeClass).toBe("small");
    expect(cfg.llm.baseUrl).toBe("https://openrouter.ai/api/v1");
    expect(cfg.postgres.url).toBe("postgres://sailor:sailor@localhost:5432/sailor");
    expect(cfg.redis.url).toBe("redis://localhost:6379");
    expect(cfg.github.appId).toBeUndefined();
    expect(cfg.github.botLogin).toBeUndefined();
    expect(cfg.auth.devBypass).toBe(false);
    expect(cfg.auth.sessionTtlDays).toBe(30);
    expect(cfg.server.port).toBe(8787);
    expect(cfg.server.publicUrl).toBe("http://localhost:5173");
  });

  it("reads overrides from the environment", () => {
    const cfg = loadConfig({
      SAILOR_SANDBOX_PROVIDER: "e2b",
      E2B_API_KEY: "e2b_test",
      E2B_TEMPLATE: "custom-template:latest",
      E2B_USER: "root",
      E2B_TIMEOUT_MS: "900000",
      HEYO_TOKEN: "tok",
      HEYO_SIZE_CLASS: "medium",
      HEYO_DISK_GB: "8",
      DATABASE_URL: "postgres://db:6432/other",
      LLM_MODEL: "some/model",
      GITHUB_APP_ID: "12345",
      GITHUB_APP_SLUG: "sailor-dev",
      GITHUB_WEBHOOK_SECRET: "whsec",
      SAILOR_PORT: "9999",
      SAILOR_PUBLIC_URL: "https://dash.example",
      DEV_AUTH_BYPASS: "1",
    });
    expect(cfg.sandbox.provider).toBe("e2b");
    expect(cfg.sandbox.e2b.apiKey).toBe("e2b_test");
    expect(cfg.sandbox.e2b.template).toBe("custom-template:latest");
    expect(cfg.sandbox.e2b.user).toBe("root");
    expect(cfg.sandbox.e2b.timeoutMs).toBe(900_000);
    expect(cfg.heyo.token).toBe("tok");
    expect(cfg.heyo.sizeClass).toBe("medium");
    expect(cfg.heyo.diskSizeGb).toBe(8);
    expect(cfg.postgres.url).toBe("postgres://db:6432/other");
    expect(cfg.llm.model).toBe("some/model");
    expect(cfg.github.appId).toBe("12345");
    expect(cfg.github.botLogin).toBe("sailor-dev[bot]");
    expect(cfg.github.webhookSecret).toBe("whsec");
    expect(cfg.server.port).toBe(9999);
    expect(cfg.server.publicUrl).toBe("https://dash.example");
    expect(cfg.auth.secureCookies).toBe(true); // https public URL
    expect(cfg.auth.devBypass).toBe(true);
  });

  it("rejects invalid size classes loudly", () => {
    expect(() => loadConfig({ HEYO_SIZE_CLASS: "huge" })).toThrow(/HEYO_SIZE_CLASS/);
  });

  it("rejects an unknown sandbox provider loudly", () => {
    expect(() =>
      loadConfig({ SAILOR_SANDBOX_PROVIDER: "firecracker" }),
    ).toThrow(/SAILOR_SANDBOX_PROVIDER/);
  });
});
