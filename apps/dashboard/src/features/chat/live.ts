/**
 * Live run projections (`event: live` over SSE) — compact frames the worker
 * publishes while a run executes: cumulative assistant text (~10/s), phase
 * moves, tool call/result, finish. The reducer folds frames into the state
 * the streaming bubble renders; the DB remains the truth and refetch wins.
 */
export interface LiveEvent {
  threadId: string;
  runId: string;
  kind:
    | "llm_started"
    | "delta"
    | "assistant_done"
    | "tool_call"
    | "tool_result"
    | "phase"
    | "guardrail"
    | "run_finished"
    | "error";
  text?: string;
  phase?: string | null;
  step?: number;
  name?: string;
  ok?: boolean;
  content?: string;
  summary?: string | null;
  disposition?: string | null;
  reason?: string;
  message?: string;
  guardrail?: string;
  detail?: string;
  via?: string | null;
  tools?: string[];
}

export interface LiveState {
  runId: string;
  phase: string | null;
  text: string;
  tools: Array<{ name: string; ok?: boolean }>;
  startedAt: number;
}

export function emptyLive(runId: string, phase: string | null): LiveState {
  return { runId, phase, text: "", tools: [], startedAt: Date.now() };
}

export function applyLiveEvent(prev: LiveState | null, event: LiveEvent): LiveState | null {
  switch (event.kind) {
    case "llm_started":
      return {
        runId: event.runId,
        phase: event.phase ?? prev?.phase ?? null,
        text: "",
        tools: prev?.runId === event.runId ? prev.tools : [],
        startedAt: prev?.startedAt ?? Date.now(),
      };
    case "delta":
      if (!prev || prev.runId !== event.runId) return prev;
      return { ...prev, text: event.text ?? "" };
    case "assistant_done":
      if (!prev || prev.runId !== event.runId) return prev;
      return { ...prev, text: event.text ?? prev.text };
    case "phase":
      if (!prev || prev.runId !== event.runId) return prev;
      return { ...prev, phase: event.phase ?? prev.phase };
    case "tool_call":
      if (!prev || prev.runId !== event.runId) return prev;
      return { ...prev, tools: [...prev.tools, { name: event.name ?? "tool" }].slice(-6) };
    case "tool_result":
      if (!prev || prev.runId !== event.runId) return prev;
      return {
        ...prev,
        tools: prev.tools.map((t, i) =>
          i === prev.tools.length - 1 && t.ok === undefined ? { ...t, ok: event.ok } : t,
        ),
      };
    default:
      return prev;
  }
}
