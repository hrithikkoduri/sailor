/**
 * Where a thread's work happens — the follow-up clone rule (step 13):
 * GitHub threads with an open PR continue ON the PR branch.
 */
import { describe, expect, it } from "vitest";
import { sandboxSpecForThread } from "../../src/runs/execute.js";

const base = "/base";

describe("sandboxSpecForThread", () => {
  it("github + open PR → clones the PR branch (follow-up work continues there)", () => {
    expect(
      sandboxSpecForThread({ source: "github", repo: "acme/demo", headRef: "harness/issue-7", prNumber: 42 }, base),
    ).toEqual({ repoUrl: "https://github.com/acme/demo.git", ref: "harness/issue-7" });
  });

  it("github without a PR → default branch, no ref", () => {
    expect(
      sandboxSpecForThread({ source: "github", repo: "acme/demo", headRef: "harness/issue-7", prNumber: null }, base),
    ).toEqual({ repoUrl: "https://github.com/acme/demo.git" });
  });

  it("local paths stay local", () => {
    expect(
      sandboxSpecForThread({ source: "local", repo: "fixtures/x", headRef: null, prNumber: null }, base),
    ).toEqual({ localPath: "/base/fixtures/x" });
  });
});
