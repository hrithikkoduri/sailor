import type { ConversationPart, RunConversation } from "./types";

export interface LiveEvent {
  threadId: string;
  runId: string;
  sequence?: number;
  step?: number;
  kind:
    | "started"
    | "llm_started"
    | "delta"
    | "reasoning"
    | "assistant_done"
    | "tool_call"
    | "tool_result"
    | "phase"
    | "guardrail"
    | "run_finished"
    | "error";
  text?: string;
  reasoning?: string;
  reasoningTokens?: number;
  phase?: string | null;
  callId?: string;
  name?: string;
  verb?: string;
  input?: Record<string, unknown>;
  content?: string;
  ok?: boolean;
  summary?: string | null;
  message?: string;
  /** run_started carries the strategy's full phase list, in order. */
  phases?: string[];
}
export interface LiveState extends RunConversation {
  runId: string;
  phase: string | null;
  startedAt: number;
  phases: string[];
  visited: string[];
}
export const emptyLive = (runId: string, phase: string | null): LiveState => ({
  runId,
  phase,
  startedAt: Date.now(),
  parts: [],
  sequence: -1,
  finished: false,
  phases: [],
  visited: [],
});

const rank = (p: ConversationPart) =>
  p.id === "final" ? 4 : p.kind === "reasoning" ? 0 : p.kind === "text" ? 1 : 2;
export function mergeConversation(
  saved: RunConversation | undefined,
  live: LiveState | null,
): RunConversation {
  if (!live) return saved ?? { parts: [], sequence: -1, finished: false };
  if (saved && saved.sequence >= live.sequence) return saved;
  const map = new Map((saved?.parts ?? []).map((part) => [part.id, part]));
  for (const part of live.parts)
    if (!map.has(part.id) || map.get(part.id)!.sequence <= part.sequence)
      map.set(part.id, part);
  const parts = [...map.values()].sort(
    (a, b) => a.step - b.step || rank(a) - rank(b) || a.sequence - b.sequence,
  );
  return {
    parts,
    sequence: live.sequence,
    finished: live.finished || saved?.finished === true,
    phases: live.phases.length ? live.phases : saved?.phases,
    visited: live.visited.length ? live.visited : saved?.visited,
    phase: live.phase ?? saved?.phase ?? null,
  };
}

/** Accept a delta even if llm_started was missed. Never reset previous steps. */
export function applyLiveEvent(
  prev: LiveState | null,
  event: LiveEvent,
): LiveState {
  const state =
    prev?.runId === event.runId
      ? prev
      : emptyLive(event.runId, event.phase ?? null);
  const sequence = event.sequence ?? state.sequence + 1;
  if (sequence <= state.sequence) return state;
  const next = {
    ...state,
    parts: state.parts.map((p) => ({ ...p })),
    sequence,
  };
  const step = event.step ?? 1;
  const text = (kind: "text" | "reasoning") => {
    const id = `${kind}-${step}`;
    let part = next.parts.find((p) => p.id === id);
    if (!part) {
      part = { id, kind, step, sequence, text: "", complete: false };
      next.parts.push(part);
    }
    part.sequence = sequence;
    return part;
  };
  switch (event.kind) {
    case "llm_started":
      text("text");
      next.phase = event.phase ?? next.phase;
      break;
    case "delta": {
      text("text").text = event.text ?? "";
      const reasoning = next.parts.find(
        (part) => part.id === `reasoning-${step}`,
      );
      if (reasoning) reasoning.complete = true;
      break;
    }
    case "reasoning":
      text("reasoning").text = event.text ?? "";
      break;
    case "assistant_done": {
      Object.assign(text("text"), { text: event.text ?? "", complete: true });
      if (
        event.reasoning ||
        event.reasoningTokens !== undefined ||
        next.parts.some((p) => p.id === `reasoning-${step}`)
      ) {
        const part = text("reasoning");
        if (event.reasoning !== undefined) part.text = event.reasoning;
        part.reasoningTokens = event.reasoningTokens;
        part.complete = true;
      }
      break;
    }
    case "tool_call":
    case "tool_result": {
      const name = event.name ?? "tool";
      const id = event.callId
        ? `tool-${step}-${event.callId}`
        : `tool-${step}-${name}`;
      let part = next.parts.find((p) => p.id === id);
      if (!part) {
        part = {
          id,
          kind: "tool",
          callId: event.callId,
          step,
          sequence,
          name,
          complete: false,
        };
        next.parts.push(part);
      }
      Object.assign(part, {
        sequence,
        verb: event.verb ?? part.verb ?? `Calling ${name}`,
        input: event.input ?? part.input,
      });
      if (event.kind === "tool_result")
        Object.assign(part, {
          content: event.content,
          ok: event.ok,
          complete: true,
        });
      break;
    }
    case "started":
      if (Array.isArray(event.phases) && event.phases.length)
        next.phases = event.phases;
      break;
    case "phase":
      if (event.phase) {
        next.phase = event.phase;
        if (!next.visited.includes(event.phase))
          next.visited = [...next.visited, event.phase];
        if (!next.phases.includes(event.phase))
          next.phases = [...next.phases, event.phase];
      }
      break;
    case "run_finished":
      next.finished = true;
      if (
        event.summary?.trim() &&
        event.summary.trim() !==
          next.parts
            .filter((p) => p.kind === "text" && p.text?.trim())
            .at(-1)
            ?.text?.trim()
      )
        next.parts.push({
          id: "final",
          kind: "text",
          text: event.summary,
          step,
          sequence,
          complete: true,
        });
      for (const part of next.parts) part.complete = true;
      break;
    case "error":
      next.finished = true;
      break;
  }
  return next;
}
