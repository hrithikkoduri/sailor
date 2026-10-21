import { describe, expect, it, vi } from "vitest";
import type { Sandbox } from "anchor-ai-sdk";
import { redactValue } from "../../src/agents/secret-tools.js";

describe("secret redaction", () => {
  it("replaces every literal occurrence, including repeats and partial lines", () => {
    expect(redactValue("key=sk-123 ok\nkey=sk-123", "sk-123")).toBe(
      "key=[REDACTED] ok\nkey=[REDACTED]",
    );
    expect(redactValue("nothing to hide", "sk-123")).toBe("nothing to hide");
    expect(redactValue("value", "")).toBe("value"); // never splits on an empty needle
  });
});

/** A fake sandbox that records the env each command receives. */
function fakeSandbox(output: string, exitCode = 0) {
  const calls: Array<{ command: string; env?: Record<string, string> }> = [];
  const sandbox = {
    exec: vi.fn(async (command: string, opts?: { env?: Record<string, string> }) => {
      calls.push({ command, ...(opts?.env ? { env: opts.env } : {}) });
      return { exitCode, stdout: output, stderr: "", output, timedOut: false, durationMs: 0 };
    }),
  } as unknown as Sandbox;
  return { sandbox, calls };
}

describe("run_with_secret", () => {
  it("injects the value into that command and returns a scrubbed observation", async () => {
    const { secretTools } = await import("../../src/agents/secret-tools.js");
    const { sandbox, calls } = fakeSandbox("using sk-live-9 now\nsk-live-9\n");
    const db = {
      select: () => ({
        from: () => ({
          where: async () => [
            {
              id: "s1", userId: "u1", name: "daytona", envVar: "DAYTONA_API_KEY",
              ciphertext: "", iv: "", tag: "",
              createdAt: new Date(), updatedAt: new Date(), lastUsedAt: null,
            },
          ],
        }),
      }),
      update: () => ({ set: () => ({ where: async () => undefined }) }),
    } as never;
    process.env.SAILOR_SECRET_KEY ??= Buffer.alloc(32, 3).toString("base64");

    // The store decrypts real ciphertext; here we only prove the tool's
    // plumbing and redaction, so stub the lookup to a known value.
    vi.resetModules();
    vi.doMock("../../src/secrets/store.js", () => ({
      getSecretValue: async () => ({ envVar: "DAYTONA_API_KEY", value: "sk-live-9" }),
      secretCatalog: async () => [{ name: "daytona", envVar: "DAYTONA_API_KEY" }],
    }));
    const mod = await import("../../src/agents/secret-tools.js");
    const [tool] = mod.secretTools({ db, threadId: "t1", userId: "u1", sandbox });
    const result = await tool!.run({ secret: "daytona", command: "curl -H $DAYTONA_API_KEY" }, { sandbox });
    expect(calls[0]?.env).toEqual({ DAYTONA_API_KEY: "sk-live-9" });
    expect(result.content).not.toContain("sk-live-9");
    expect(result.content).toContain("[REDACTED]");
    expect(JSON.stringify(result)).not.toContain("sk-live-9");
    vi.doUnmock("../../src/secrets/store.js");
  });

  it("tells the agent to have the user add a missing secret, without inventing one", async () => {
    vi.resetModules();
    vi.doMock("../../src/secrets/store.js", () => ({
      getSecretValue: async () => undefined,
      secretCatalog: async () => [],
    }));
    const { secretTools } = await import("../../src/agents/secret-tools.js");
    const { sandbox, calls } = fakeSandbox("");
    const [tool] = secretTools({ db: {} as never, threadId: "t", userId: "u", sandbox });
    const result = await tool!.run({ secret: "daytona", command: "echo hi" }, { sandbox });
    expect(result.ok).toBe(false);
    expect(result.content).toMatch(/Settings → Secrets/);
    expect(calls).toHaveLength(0); // never runs with an empty/placeholder key
    vi.doUnmock("../../src/secrets/store.js");
  });

  it("refuses a thread with no owner", async () => {
    vi.resetModules();
    const { secretTools } = await import("../../src/agents/secret-tools.js");
    const { sandbox, calls } = fakeSandbox("");
    const [tool] = secretTools({ db: {} as never, threadId: "t", userId: null, sandbox });
    const result = await tool!.run({ secret: "x", command: "echo hi" }, { sandbox });
    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
});