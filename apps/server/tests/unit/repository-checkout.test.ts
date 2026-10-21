import { describe, expect, it } from "vitest";
import type { Sandbox } from "anchor-ai-sdk";
import { findAdHocCheckouts } from "../../src/runs/execute.js";

/** A sandbox that answers only the two probes the scanner makes. */
function fakeSandbox(files: Record<string, string>, workspace = "/home/user/repo"): Sandbox {
  return {
    workspace,
    exec: async (command: string, opts?: { cwd?: string }) => {
      const ok = (stdout: string) => ({ exitCode: 0, stdout, stderr: "", output: stdout, timedOut: false, durationMs: 0 });
      if (command.startsWith("for root in")) return ok(Object.keys(files).join("\n"));
      if (command === "git config --get remote.origin.url") {
        const remote = files[`${opts?.cwd}/.git`];
        return remote ? ok(remote) : { ...ok(""), exitCode: 1 };
      }
      return ok("");
    },
  } as unknown as Sandbox;
}

describe("findAdHocCheckouts", () => {
  it("reports sibling clones with a GitHub origin, ignoring the workspace itself", async () => {
    const sandbox = fakeSandbox({
      "/home/user/repo/.git": "https://github.com/acme/sailor.git",
      "/home/user/anchor-ai-sdk/.git": "https://github.com/acme/anchor-ai-sdk.git",
      "/tmp/random/.git": "https://gitlab.com/acme/other.git",
    });
    expect(await findAdHocCheckouts(sandbox, "/home/user/repo")).toEqual([
      { repository: "acme/anchor-ai-sdk", path: "/home/user/anchor-ai-sdk" },
    ]);
  });

  it("handles ssh remotes, nested paths, and no checkouts", async () => {
    const nested = fakeSandbox({
      "/workspace/apps/x/.git": "git@github.com:acme/web-app.git",
    }, "/workspace/apps/x");
    expect(await findAdHocCheckouts(nested, "/workspace/apps/x")).toEqual([]);
    expect(await findAdHocCheckouts(fakeSandbox({}), "/home/user/repo")).toEqual([]);
  });

  it("normalizes the trailing .git and keeps owner/name", async () => {
    const sandbox = fakeSandbox({ "/home/user/other/.git": "https://github.com/Acme/Repo.git" });
    expect(await findAdHocCheckouts(sandbox, "/home/user/repo")).toEqual([
      { repository: "Acme/Repo", path: "/home/user/other" },
    ]);
  });
});
