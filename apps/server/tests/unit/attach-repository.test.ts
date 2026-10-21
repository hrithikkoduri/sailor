import { describe, expect, it } from "vitest";
import { attachRepository } from "../../src/agents/questions-tools.js";
import type { Sandbox } from "anchor-ai-sdk";

describe("attachRepository", () => {
  it("never overwrites an existing repository or workspace changes", async () => {
    let commands: string[] = [];
    const sandbox = { exec: async (command: string) => {
      commands.push(command);
      return { exitCode: 0, stdout: "https://github.com/other/repo.git\n", output: "", stderr: "", timedOut: false, durationMs: 0 };
    } } as unknown as Sandbox;
    await expect(attachRepository({ sandbox, repo: "acme/web", branch: "main" })).rejects.toThrow(/already has/);
    expect(commands).toHaveLength(1);
    commands = [];
    sandbox.exec = async (command: string) => {
      commands.push(command);
      return { exitCode: command.includes("get-url") ? 1 : 0, stdout: "important.py", output: "", stderr: "", timedOut: false, durationMs: 0 };
    };
    await expect(attachRepository({ sandbox, repo: "acme/web", branch: "main" })).rejects.toThrow(/contains work/);
    expect(commands.some((c) => c.includes("fetch"))).toBe(false);
  });
});
