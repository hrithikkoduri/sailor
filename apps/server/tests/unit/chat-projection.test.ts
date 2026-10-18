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
      verb: "Reading repository file test.ts",
    });
    expect(result.parts.find((p) => p.kind === "reasoning")).toMatchObject({
      reasoningTokens: 24,
    });
    expect(result.finished).toBe(true);
  });
  it("tracks the phase trail: listed phases, actually-visited order, current phase", () => {
    const result = projectConversation(
      [
        event(0, "run_started", {
          task: "t",
          phases: ["understand", "act", "validate", "respond"],
        }),
        event(1, "phase_started", { phase: "understand" }),
        event(2, "phase_started", { phase: "validate" }),
      ],
      "running",
    );
    expect(result.phases).toEqual(["understand", "act", "validate", "respond"]);
    expect(result.visited).toEqual(["understand", "validate"]);
    expect(result.phase).toBe("validate");
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
  it("enriches old generic activity labels on replay without replacing custom labels", () => {
    const events = [
      event(0, "tool_call", {
        step: 1,
        callId: "a",
        name: "bash",
        verb: "Running a command",
        input: { command: "git diff --stat" },
      }),
      event(1, "tool_result", {
        step: 1,
        callId: "a",
        name: "bash",
        verb: "Running a command",
        ok: true,
      }),
      event(2, "tool_call", {
        step: 1,
        callId: "b",
        name: "bash",
        verb: "Inspecting the dataset boundary conditions",
        input: { command: "python check.py" },
      }),
    ];
    const result = projectConversation(events, "succeeded");
    expect(result.parts[0]?.verb).toBe("Reviewing the repository code diff");
    expect(result.parts[1]?.verb).toBe(
      "Inspecting the dataset boundary conditions",
    );
    expect(events[0]?.payload).toMatchObject({ verb: "Running a command" });
  });
  it("renders compaction as its own part: fold counts, summary, folded transcript", () => {
    const result = projectConversation(
      [
        event(0, "tool_call", {
          step: 1,
          callId: "a",
          name: "bash",
          verb: "Running a command",
          input: { command: "ls" },
        }),
        event(1, "tool_result", {
          step: 1,
          callId: "a",
          name: "bash",
          ok: true,
          content: "ok",
        }),
        event(2, "compacted", {
          removedMessages: 21,
          keptMessages: 16,
          summaryChars: 46,
          summary: "Folded earlier exploration into this summary.",
          folding: "assistant → bash(ls)\ntool result: ok",
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        }),
        event(3, "llm_call_finished", {
          step: 2,
          text: "Continuing from the summary.",
        }),
      ],
      "succeeded",
    );
    // Order: step-1 activity, the compaction marker, then step-2 text.
    expect(result.parts.map((p) => p.kind)).toEqual([
      "tool",
      "compaction",
      "text",
    ]);
    expect(result.parts.find((p) => p.kind === "compaction")).toMatchObject({
      id: "compaction-2",
      step: 1,
      removedMessages: 21,
      keptMessages: 16,
      summary: "Folded earlier exploration into this summary.",
      folding: "assistant → bash(ls)\ntool result: ok",
      complete: true,
    });
  });
});

describe("live projection", () => {
  it("forwards the phase list and phase moves for the composer trail", () => {
    const frames: Record<string, unknown>[] = [];
    const emit = createLiveProjector((frame) => frames.push(frame));
    emit({
      type: "run_started",
      task: "t",
      phases: ["understand", "act", "validate", "respond"],
    });
    expect(frames.at(-1)).toMatchObject({
      kind: "started",
      phases: ["understand", "act", "validate", "respond"],
    });
    emit({ type: "phase_started", phase: "act" });
    expect(frames.at(-1)).toMatchObject({ kind: "phase", phase: "act" });
  });
  it("redacts token-shaped values before live debug input/output reaches the browser", () => {
    const frames: Record<string, unknown>[] = [];
    const emit = createLiveProjector((frame) => frames.push(frame));
    const token = `ghs_${"a".repeat(30)}`;
    emit({
      type: "tool_call",
      phase: "act",
      step: 1,
      name: "bash",
      input: { command: `echo ${token}` },
    });
    emit({
      type: "tool_result",
      phase: "act",
      step: 1,
      name: "bash",
      ok: false,
      content: token,
      contentChars: token.length,
    });
    expect(JSON.stringify(frames)).not.toContain(token);
    expect(JSON.stringify(frames)).toContain("REDACTED");
  });
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
  it("publishes compaction as a live frame carrying the summary", () => {
    const frames: Record<string, unknown>[] = [];
    const emit = createLiveProjector((frame) => frames.push(frame));
    emit({ type: "llm_call_started", step: 4, phase: "act" });
    emit({
      type: "compacted",
      removedMessages: 21,
      keptMessages: 16,
      summaryChars: 46,
      summary: "Folded earlier exploration into this summary.",
      folding: "assistant → bash(ls)",
      usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
    });
    expect(frames.at(-1)).toMatchObject({
      kind: "compacted",
      step: 4,
      removedMessages: 21,
      keptMessages: 16,
      summary: "Folded earlier exploration into this summary.",
      folding: "assistant → bash(ls)",
    });
  });
});
