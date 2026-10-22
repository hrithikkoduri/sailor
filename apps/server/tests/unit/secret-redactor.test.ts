import { describe, expect, it } from "vitest";
import type { Tool } from "anchor-ai-sdk";
import { REDACTED, SecretRedactor, secretVariants } from "../../src/services/secrets/redactor.js";
import { buildSailorPrompt } from "../../src/services/agents/prompts.js";

describe("SecretRedactor", () => {
  it("redacts literal, base64, and URL-encoded forms", () => {
    const redactor = new SecretRedactor();
    const value = "sk-live-abcdefghijklmnop";
    redactor.add(value);
    const base64 = Buffer.from(value, "utf8").toString("base64");
    const url = encodeURIComponent(value);

    expect(redactor.redact(`token=${value}`)).toBe(`token=${REDACTED}`);
    expect(redactor.redact(`encoded=${base64}`)).toBe(`encoded=${REDACTED}`);
    expect(redactor.redact(`url=${url}`)).toBe(`url=${REDACTED}`);
  });

  it("walks strings inside arrays and objects", () => {
    const redactor = new SecretRedactor();
    redactor.add("a-long-secret-value");
    const input = { content: "value a-long-secret-value", nested: ["a-long-secret-value", 3] };
    expect(redactor.redactDeep(input)).toEqual({
      content: `value ${REDACTED}`,
      nested: [REDACTED, 3],
    });
  });

  it("wraps a tool result before it reaches the model or trace", async () => {
    const redactor = new SecretRedactor();
    redactor.add("another-long-secret");
    const tool: Tool = {
      definition: { name: "bash", description: "run", parameters: {} },
      async run() {
        return {
          ok: true,
          content: "export TOKEN=another-long-secret",
          meta: { command: "echo another-long-secret" },
          verb: "running another-long-secret",
        };
      },
    };
    const wrapped = redactor.wrap(tool);
    const result = await wrapped.run({}, {});
    expect(result.content).toBe(`export TOKEN=${REDACTED}`);
    expect(result.meta).toEqual({ command: `echo ${REDACTED}` });
    expect(result.verb).toBe(`running ${REDACTED}`);
  });

  it("ignores short values and exposes variants for the scan", () => {
    const redactor = new SecretRedactor();
    redactor.add("abc");
    expect(redactor.size).toBe(0);
    expect(secretVariants("short")).toEqual([]);
    expect(secretVariants("long-enough-secret")).toContain("long-enough-secret");
  });
});

describe("prompt guard", () => {
  it("does not mention a host allowlist that Sailor does not implement", () => {
    const prompt = buildSailorPrompt("{}");
    expect(prompt.toLowerCase()).not.toContain("allowlist");
  });
});
