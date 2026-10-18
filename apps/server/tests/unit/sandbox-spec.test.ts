/**
 * Where a thread's work happens — the follow-up clone rule (step 13):
 * GitHub threads with an open PR continue ON the PR branch, and once an
 * off-machine checkpoint branch exists (B) it wins: it carries the latest
 * workspace state, force-pushed every turn.
 */
import { describe, expect, it } from "vitest";
import { sandboxSpecForThread } from "../../src/runs/execute.js";

const base = "/base";

describe("sandboxSpecForThread", () => {
  it("github + open PR → clones the PR branch (follow-up work continues there)", () => {
    expect(
      sandboxSpecForThread(
        {
          source: "github",
          repo: "acme/demo",
          headRef: "sailor/issue-7",
          prNumber: 42,
          checkpointRef: null,
        },
        base,
      ),
    ).toEqual({
      repoUrl: "https://github.com/acme/demo.git",
      ref: "sailor/issue-7",
    });
  });

  it("github without a PR → default branch, no ref", () => {
    expect(
      sandboxSpecForThread(
        {
          source: "github",
          repo: "acme/demo",
          headRef: "sailor/issue-7",
          prNumber: null,
          checkpointRef: null,
        },
        base,
      ),
    ).toEqual({ repoUrl: "https://github.com/acme/demo.git" });
  });

  it("github + checkpoint branch → clones the checkpoint branch (latest workspace, even over a PR)", () => {
    expect(
      sandboxSpecForThread(
        {
          source: "github",
          repo: "acme/demo",
          headRef: "sailor/issue-7",
          prNumber: 42,
          checkpointRef: "sailor/issue-7-checkpoint",
        },
        base,
      ),
    ).toEqual({
      repoUrl: "https://github.com/acme/demo.git",
      ref: "sailor/issue-7-checkpoint",
    });
  });

  it("local paths stay local", () => {
    expect(
      sandboxSpecForThread(
        {
          source: "local",
          repo: "fixtures/x",
          headRef: null,
          prNumber: null,
          checkpointRef: null,
        },
        base,
      ),
    ).toEqual({ localPath: "/base/fixtures/x" });
  });
});
