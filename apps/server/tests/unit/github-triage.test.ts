/**
 * Triage (decision #28) — self vs external + semantics. Pure tests.
 */
import { describe, expect, it } from "vitest";
import { classifyGithubEvent } from "../../src/services/github/triage.js";

describe("classifyGithubEvent", () => {
  it("self-authored events queue — not suppressed, rendered as acknowledge", () => {
    const d = classifyGithubEvent("push", { sender: { login: "sailor-bot", type: "Bot" } }, { botLogin: "sailor-bot" });
    expect(d.action).toBe("queue");
    expect(d.reason).toMatch(/self/i);
  });

  it("a review from OUR bot is a self event, not an interjection", () => {
    const d = classifyGithubEvent("pull_request_review", { sender: { login: "me-bot" } }, { botLogin: "me-bot" });
    expect(d.action).toBe("queue");
  });

  it("reviews interject — ANY author: human or review bot", () => {
    expect(classifyGithubEvent("pull_request_review", { sender: { login: "coderabbitai[bot]", type: "Bot" } }).action).toBe(
      "interject",
    );
    expect(classifyGithubEvent("pull_request_review", { sender: { login: "octocat", type: "User" } }).action).toBe(
      "interject",
    );
    expect(classifyGithubEvent("pull_request_review_comment", { sender: { type: "User" } }).action).toBe("interject");
  });

  it("human comments interject; external bot comments queue", () => {
    expect(classifyGithubEvent("issue_comment", { sender: { login: "octocat", type: "User" } }).action).toBe("interject");
    expect(classifyGithubEvent("issue_comment", { sender: { login: "dependabot[bot]", type: "Bot" } }).action).toBe(
      "queue",
    );
  });

  it("machine events queue", () => {
    expect(classifyGithubEvent("check_run", {}).action).toBe("queue");
    expect(classifyGithubEvent("status", {}).action).toBe("queue");
    expect(classifyGithubEvent("push", {}).action).toBe("queue");
    expect(classifyGithubEvent("issues", { sender: { type: "User" } }).action).toBe("queue");
  });
});
