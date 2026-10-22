import { describe, expect, it } from "vitest";
import { codingAgent, codingPhases, buildCodingPrompt } from "anchor-ai-sdk";
import { createSailorAgent } from "../../src/services/agents/sailor.js";
import { repairThreadHistory } from "../../scripts/repair-thread-history.js";

describe("Sailor agent composition", () => {
  it("specializes the reusable coding agent instead of defining a different behavior", () => {
    const sailor = createSailorAgent("repo: acme/notebooks, PR #2");
    expect(sailor.strategy.phases).toBe(codingAgent.strategy.phases);
    expect(sailor.strategy.phases.map((phase) => phase.id)).toEqual([
      "understand",
      "plan",
      "act",
      "validate",
      "respond",
    ]);
    expect(sailor.tools.slice(0, codingAgent.tools.length)).toEqual(
      codingAgent.tools,
    );
    const prompt = sailor.strategy.systemPrompt({
      task: "Remove the unnecessary test file",
    });
    for (const heading of [
      "Character",
      "Tone",
      "Judgment",
      "Operating rules",
      "Verification philosophy",
      "Approach phases",
      "Publication and replies",
    ])
      expect(prompt).toContain(`# ${heading}`);
    expect(prompt).toContain("You are Sailor");
    expect(prompt).toContain("repo: acme/notebooks");
    expect(prompt).toContain("conclude from any phase");
    expect(prompt).not.toContain("must be green");
  });

  it("allows independent prompt-section customization without replacing the loop or phases", () => {
    const prompt = buildCodingPrompt({
      character: "You are an internal engineering assistant.",
      tone: "Use brief technical notes.",
      context: "sandbox: local",
      summary: "Earlier work: README added.",
    });
    expect(prompt).toContain("Use brief technical notes.");
    expect(prompt).not.toContain("Be calm, concise");
    expect(prompt).toContain(
      "Choose verification that provides meaningful evidence",
    );
    for (const phase of codingPhases) expect(prompt).toContain(phase.goal);
  });

  it("repairs known historical runtime directives separately, preserving genuine messages and observations", () => {
    const messages = [
      {
        role: "user" as const,
        content: "PHASE: investigate — this is my document title",
      },
      {
        role: "user" as const,
        content:
          "PHASE: fix — make the failing test pass with a minimal change.",
      },
      {
        role: "user" as const,
        content:
          'You have spent 21 turns in the "fix" phase (soft limit 20). Keep working.',
      },
      { role: "assistant" as const, content: "I read the README." },
      { role: "tool" as const, tool_call_id: "a", content: "observed content" },
    ];
    const repaired = repairThreadHistory(messages);
    expect(repaired).toEqual([messages[0], messages[3], messages[4]]);
    expect(messages).toHaveLength(5);
    expect(repairThreadHistory(repaired)).toEqual(repaired);
  });
});
