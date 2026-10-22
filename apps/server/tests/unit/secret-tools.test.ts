import { describe, expect, it, vi } from "vitest";
import type { Sandbox } from "anchor-ai-sdk";
import { redactValue } from "../../src/services/agents/tools/secret.js";

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

describe("secrets tool", () => {
  it("injects the value into that command and returns a scrubbed observation", async () => {
    const { secretTools } = await import("../../src/services/agents/tools/secret.js");
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
    vi.doMock("../../src/services/secrets/store.js", () => ({
      getSecretValue: async () => ({ envVar: "DAYTONA_API_KEY", value: "sk-live-9" }),
      secretCatalog: async () => [{ name: "daytona", envVar: "DAYTONA_API_KEY" }],
    }));
    const mod = await import("../../src/services/agents/tools/secret.js");
    const [tool] = mod.secretTools({ db, threadId: "t1", userId: "u1", sandbox });
    const result = await tool!.run({ mode: "use_secret", secret: "daytona", command: "curl -H $DAYTONA_API_KEY" }, { sandbox });
    expect(calls[0]?.env).toEqual({ DAYTONA_API_KEY: "sk-live-9" });
    expect(result.content).not.toContain("sk-live-9");
    expect(result.content).toContain("[REDACTED]");
    expect(JSON.stringify(result)).not.toContain("sk-live-9");
    vi.doUnmock("../../src/services/secrets/store.js");
  });

  it("tells the agent to have the user add a missing secret, without inventing one", async () => {
    vi.resetModules();
    vi.doMock("../../src/services/secrets/store.js", () => ({
      getSecretValue: async () => undefined,
      secretCatalog: async () => [],
    }));
    const { secretTools } = await import("../../src/services/agents/tools/secret.js");
    const { sandbox, calls } = fakeSandbox("");
    const [tool] = secretTools({ db: {} as never, threadId: "t", userId: "u", sandbox });
    const result = await tool!.run({ mode: "use_secret", secret: "daytona", command: "echo hi" }, { sandbox });
    expect(result.ok).toBe(false);
    expect(result.content).toMatch(/ask_user/);
    expect(calls).toHaveLength(0); // never runs with an empty/placeholder key
    vi.doUnmock("../../src/services/secrets/store.js");
  });

  it("lists names only and requests a missing secret through a form", async () => {
    vi.resetModules();
    vi.doMock("../../src/services/secrets/store.js", () => ({
      getSecretValue: async () => undefined,
      secretCatalog: async () => [{ name: "daytona", envVar: "DAYTONA_API_KEY" }],
    }));
    const { secretTools } = await import("../../src/services/agents/tools/secret.js");
    const { sandbox } = fakeSandbox("");
    let requested = "";
    const db = {
      insert: () => ({ values: () => ({ returning: async () => [{ id: "question-1" }] }) }),
    } as never;
    const [tool] = secretTools({ db, threadId: "t", userId: "u", sandbox,
      onQuestions: (id) => { requested = id; } });

    const listed = await tool!.run({ mode: "list_secret" }, { sandbox });
    expect(listed.content).toContain("DAYTONA_API_KEY");
    expect(listed.content).not.toContain("sk-live");

    const asked = await tool!.run({ mode: "ask_user", secret: "github", env_var: "GITHUB_TOKEN",
      title: "GitHub token", description: "Create one at github.com/settings/tokens." }, { sandbox });
    expect(asked.ok).toBe(true);
    expect(asked.content).toContain("paused");
    expect(requested).toBe("question-1");
    vi.doUnmock("../../src/services/secrets/store.js");
  });

  it("returns at once when the run is stopped, honoring the sandbox ceiling", async () => {
    vi.resetModules();
    vi.doMock("../../src/services/secrets/store.js", () => ({
      getSecretValue: async () => ({ envVar: "DAYTONA_API_KEY", value: "sk-live-9" }),
      secretCatalog: async () => [{ name: "daytona", envVar: "DAYTONA_API_KEY" }],
    }));
    const { secretTools } = await import("../../src/services/agents/tools/secret.js");
    let timeoutSecs = 0;
    // A command that never finishes on its own.
    const sandbox = {
      exec: vi.fn((_command: string, opts?: { timeoutSecs?: number }) => {
        timeoutSecs = opts?.timeoutSecs ?? 0;
        return new Promise(() => undefined);
      }),
    } as unknown as Sandbox;
    const controller = new AbortController();
    const [tool] = secretTools({ db: {} as never, threadId: "t", userId: "u", sandbox, signal: controller.signal });
    const running = tool!.run({ mode: "use_secret", secret: "daytona", command: "sleep 9999", timeout_secs: 9999 }, { sandbox });
    controller.abort();
    const result = await running;
    expect(result.ok).toBe(false);
    expect(result.content).toMatch(/interrupted/);
    expect(timeoutSecs).toBe(3600);
    vi.doUnmock("../../src/services/secrets/store.js");
  });

  it("refuses a thread with no owner", async () => {
    vi.resetModules();
    const { secretTools } = await import("../../src/services/agents/tools/secret.js");
    const { sandbox, calls } = fakeSandbox("");
    const [tool] = secretTools({ db: {} as never, threadId: "t", userId: null, sandbox });
    const result = await tool!.run({ mode: "use_secret", secret: "x", command: "echo hi" }, { sandbox });
    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
});