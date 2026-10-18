import { describe, expect, it } from "vitest";
import { projectConversation } from "../../src/chat/projection.js";
import { createLiveProjector } from "../../src/runs/live-projector.js";

const event = (
  seq: number,
  type: string,
  payload: Record<string, unknown>,
) => ({ seq, type, payload });
describe("conversation projection", () => {
  it("rebuilds partial text and reasoning from the journal without a finished call", () => {
    const result = projectConversation(
      [
        event(0, "llm_call_started", { step: 1 }),
        event(1, "llm_reasoning_delta", { text: "Checking the repository." }),
        event(2, "llm_text_delta", { text: "I found " }),
        event(3, "llm_text_delta", { text: "the change." }),
      ],
      "running",
    );
    expect(result.parts.map((p) => p.kind)).toEqual(["reasoning", "text"]);
    expect(result.parts[1]?.text).toBe("I found the change.");
    expect(result.finished).toBe(false);
    expect(result.sequence).toBe(3);
  });
  it("keeps assistant/tool/assistant order and pairs repeated tool names by call ID", () => {
    const result = projectConversation(
      [
        event(0, "llm_call_finished", {
          step: 1,
          text: "I’ll inspect the files.",
        }),
        event(1, "tool_call", {
          step: 1,
          name: "read_file",
          callId: "a",
          verb: "Reading README.md",
          input: { path: "README.md" },
        }),
        event(2, "tool_call", {
          step: 1,
          name: "read_file",
          callId: "b",
          input: { path: "test.ts" },
        }),
        event(3, "tool_result", {
          step: 1,
          name: "read_file",
          callId: "b",
          ok: true,
          content: "tests",
        }),
        event(4, "tool_result", {
          step: 1,
          name: "read_file",
          callId: "a",
          ok: true,
          content: "readme",
        }),
        event(5, "llm_call_finished", {
          step: 2,
          text: "Here’s what changed.",
          reasoning: "Checked the diff.",
          usage: { reasoningTokens: 24 },
        }),
        event(6, "run_finished", { summary: "Here’s what changed." }),
      ],
      "succeeded",
    );
    expect(
      result.parts.filter((p) => p.kind === "text").map((p) => p.text),
    ).toEqual(["I’ll inspect the files.", "Here’s what changed."]);
    expect(result.parts.find((p) => p.callId === "a")).toMatchObject({
      content: "readme",
      verb: "Reading README.md",
    });
    expect(result.parts.find((p) => p.callId === "b")).toMatchObject({
      content: "tests",
      verb: "Reading test.ts",
    });
    expect(result.parts.find((p) => p.kind === "reasoning")).toMatchObject({
      reasoningTokens: 24,
    });
    expect(result.finished).toBe(true);
  });
  it("uses finish summaries for legacy coding runs that ended in tool calls", () => {
    const result = projectConversation(
      [event(0, "run_finished", { summary: "Fixed the bug." })],
      "succeeded",
    );
    expect(result.parts).toMatchObject([
      { id: "final", text: "Fixed the bug." },
    ]);
  });
});

describe("live projection", () => {
  it("publishes step-scoped cumulative text immediately and flushes the final short chunk", () => {
    const frames: Record<string, unknown>[] = [];
    let clock = 1000;
    const emit = createLiveProjector(
      (frame) => frames.push(frame),
      () => clock,
    );
    emit({ type: "llm_call_started", step: 1, phase: "respond" });
    emit({ type: "llm_text_delta", text: "Hello " });
    clock += 10;
    emit({ type: "llm_text_delta", text: "world" });
    expect(frames.at(-1)).toMatchObject({
      kind: "delta",
      text: "Hello ",
      step: 1,
    });
    emit({
      type: "llm_call_finished",
      step: 1,
      phase: "respond",
      text: "Hello world",
      textChars: 11,
      toolCalls: [],
      toolCallsCount: 0,
      usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
      latencyMs: 20,
    });
    expect(frames.at(-1)).toMatchObject({
      kind: "assistant_done",
      text: "Hello world",
      step: 1,
      sequence: 3,
    });
  });
});
