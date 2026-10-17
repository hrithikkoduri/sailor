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
    expect(cfg.heyo.server).toBe("https://admin.us5.heyo.work");
    expect(cfg.heyo.sizeClass).toBe("small");
    expect(cfg.llm.baseUrl).toBe("https://openrouter.ai/api/v1");
    expect(cfg.postgres.url).toBe("postgres://harness:harness@localhost:5432/harness");
    expect(cfg.redis.url).toBe("redis://localhost:6379");
    expect(cfg.github.token).toBeUndefined();
    expect(cfg.github.webhookSecret).toBeUndefined();
    expect(cfg.server.port).toBe(8787);
    expect(cfg.server.publicUrl).toBe("http://localhost:5173");
  });

  it("reads overrides from the environment", () => {
    const cfg = loadConfig({
      HEYO_TOKEN: "tok",
      HEYO_SIZE_CLASS: "medium",
      HEYO_DISK_GB: "8",
      DATABASE_URL: "postgres://db:6432/other",
      LLM_MODEL: "some/model",
      GITHUB_TOKEN: "ghp_x",
      GITHUB_WEBHOOK_SECRET: "whsec",
      GITHUB_BOT_LOGIN: "harness-bot",
      HARNESS_PORT: "9999",
      HARNESS_PUBLIC_URL: "https://dash.example",
    });
    expect(cfg.heyo.token).toBe("tok");
    expect(cfg.heyo.sizeClass).toBe("medium");
    expect(cfg.heyo.diskSizeGb).toBe(8);
    expect(cfg.postgres.url).toBe("postgres://db:6432/other");
    expect(cfg.llm.model).toBe("some/model");
    expect(cfg.github.token).toBe("ghp_x");
    expect(cfg.github.webhookSecret).toBe("whsec");
    expect(cfg.github.botLogin).toBe("harness-bot");
    expect(cfg.server.port).toBe(9999);
    expect(cfg.server.publicUrl).toBe("https://dash.example");
  });

  it("rejects invalid size classes loudly", () => {
    expect(() => loadConfig({ HEYO_SIZE_CLASS: "huge" })).toThrow(/HEYO_SIZE_CLASS/);
  });
});
