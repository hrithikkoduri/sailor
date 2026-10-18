import type { AgentEvent } from "@harness/agent";

/** Keep the live path independent of slow journal writes; snapshots are step-scoped. */
export function createLiveProjector(
  send: (event: Record<string, unknown>) => void,
  now = Date.now,
) {
  let step = 0;
  let sequence = -1;
  let text = "";
  let reasoning = "";
  let lastText = Number.NEGATIVE_INFINITY;
  let lastReasoning = Number.NEGATIVE_INFINITY;
  return (event: AgentEvent) => {
    sequence++;
    if ("step" in event) step = event.step;
    const publish = (payload: Record<string, unknown>) =>
      send({ sequence, step, ...payload });
    switch (event.type) {
      case "llm_call_started":
        text = "";
        reasoning = "";
        lastText = Number.NEGATIVE_INFINITY;
        lastReasoning = Number.NEGATIVE_INFINITY;
        publish({ kind: "llm_started", phase: event.phase });
        break;
      case "llm_text_delta":
        text += event.text;
        if (now() - lastText >= 100) {
          lastText = now();
          publish({ kind: "delta", text });
        }
        break;
      case "llm_reasoning_delta":
        reasoning += event.text;
        if (now() - lastReasoning >= 100) {
          lastReasoning = now();
          publish({ kind: "reasoning", text: reasoning });
        }
        break;
      case "llm_call_finished":
        publish({
          kind: "assistant_done",
          text: event.text,
          reasoning: event.reasoning,
          reasoningTokens: event.usage.reasoningTokens,
        });
        break;
      case "tool_call":
        publish({
          kind: "tool_call",
          callId: event.callId,
          name: event.name,
          verb: event.verb,
          input: event.input,
        });
        break;
      case "tool_result":
        publish({
          kind: "tool_result",
          callId: event.callId,
          name: event.name,
          verb: event.verb,
          ok: event.ok,
          content: event.content.slice(0, 4000),
        });
        break;
      case "phase_started":
        publish({ kind: "phase", phase: event.phase });
        break;
      case "run_finished":
        publish({
          kind: "run_finished",
          summary: event.summary,
          ok: event.ok,
          reason: event.reason,
        });
        break;
      case "error":
        publish({ kind: "error", message: event.message });
        break;
    }
  };
}
