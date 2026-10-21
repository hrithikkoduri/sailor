import { describe, expect, it } from "vitest";
import { buildSailorPrompt } from "../../src/agents/prompts.js";

describe("Sailor interaction contract", () => {
  it("routes every actual user question through the structured tool, including changed scope", () => {
    const prompt = buildSailorPrompt("{}");
    expect(prompt).toContain("Whenever you have a question for the user, use ask_questions");
    expect(prompt).toContain("Never put a question or request for an answer in a normal chat response");
    expect(prompt).toContain("do not silently substitute a stub or preparatory wiring");
    expect(prompt).toContain("act on clear requests without reassurance");
  });

  it("describes issue-free PR delivery and same-run repository attachment", () => {
    const prompt = buildSailorPrompt("{}");
    expect(prompt).toContain("A GitHub issue is not required");
    expect(prompt).toContain("attach_repository unlocks publication in this same run");
  });
});
