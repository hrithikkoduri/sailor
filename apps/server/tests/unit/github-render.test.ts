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

  it("review comments carry the file:line anchor and the commented hunk", () => {
    const t = renderGithubTask("pull_request_review_comment", {
      author: "octocat",
      state: "commented",
      prTitle: "Add auth",
      path: "src/auth.ts",
      line: 42,
      side: "RIGHT",
      diffHunk:
        "@@ -40,3 +40,4 @@\n const token = read();\n-const ok = token !== null;\n+const ok = validate(token);\n export { ok };",
      body: "this breaks the token check",
    });
    expect(t).toContain("Review feedback from octocat (commented) on");
    expect(t).toContain("Add auth");
    expect(t).toContain("At src/auth.ts:42 (RIGHT side)");
    expect(t).toContain("```diff");
    expect(t).toContain("+const ok = validate(token);");
    expect(t).toContain("this breaks the token check");
    expect(t).toContain("Address this feedback as requested");
  });

  it("self comments are echoes — acknowledge in-thread, never reply on GitHub", () => {
    const t = renderGithubTask("issue_comment", {
      author: "sailor-app-dev[bot]",
      body: "Thanks — the fix is in.",
      self: true,
    });
    expect(t).toContain("No action needed");
    expect(t).toContain("echoed back");
    expect(t).toContain("Do not reply on GitHub");
    expect(t).not.toContain("Respond on the PR");
  });

  it("failed checks name the checks and say to fix + push", () => {
    const t = renderGithubTask("check_run", {
      checks: ["unit", "lint"],
      url: "https://example/ci",
    });
    expect(t).toContain("CI failed on your PR branch: unit, lint");
    expect(t).toContain("same PR using publish_changes");
    expect(t).not.toContain("usual phases");
  });

  it("dashboard chat messages expect a reply, then continuation of unfinished work", () => {
    const t = renderGithubTask("chat_message", {
      author: "hrithik",
      body: "What up?",
    });
    expect(t).toContain("Message from hrithik (dashboard chat):");
    expect(t).toContain("What up?");
    expect(t).toContain("reply to it in text");
    expect(t).toContain("continue that work after your reply");
    expect(t).not.toContain("continue toward");
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
