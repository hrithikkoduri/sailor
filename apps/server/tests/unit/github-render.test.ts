/**
 * Event → task rendering (the decision #28 voice). Pure tests.
 */
import { describe, expect, it } from "vitest";
import { renderGithubTask } from "../../src/github/render.js";

describe("renderGithubTask", () => {
  it("reviews carry the author, state, body and the act instruction", () => {
    const t = renderGithubTask("pull_request_review", {
      author: "octocat",
      state: "changes_requested",
      body: "please use approach B",
    });
    expect(t).toContain("Review feedback from octocat (changes_requested)");
    expect(t).toContain("please use approach B");
    expect(t).toContain("Address this feedback as requested");
    expect(t).not.toContain("usual phases");
    expect(t).toContain("may change the scope");
  });

  it("failed checks name the checks and say to fix + push", () => {
    const t = renderGithubTask("check_run", { checks: ["unit", "lint"], url: "https://example/ci" });
    expect(t).toContain("CI failed on your PR branch: unit, lint");
    expect(t).toContain("same PR using publish_changes");
    expect(t).not.toContain("usual phases");
  });

  it("our own push renders as an acknowledgment, not work", () => {
    const t = renderGithubTask("push", { ref: "sailor/issue-7", commits: 3 });
    expect(t).toContain("No action needed");
    expect(t).toContain("3 commits on sailor/issue-7");
  });

  it("conflicts explain the sweep found them and what to do", () => {
    const t = renderGithubTask("pr_conflict", { base: "main" });
    expect(t).toContain("conflicts with main");
    expect(t).toContain("rebase or merge");
  });

  it("unknown kinds fall back to a truncated payload", () => {
    const t = renderGithubTask("mystery", { a: 1 });
    expect(t).toContain("[mystery]");
    expect(t).toContain('"a":1');
  });
});
