import { toolVerb } from "@harness/agent";

export interface ConversationPart {
  id: string;
  kind: "text" | "reasoning" | "tool";
  step: number;
  sequence: number;
  text?: string;
  reasoningTokens?: number;
  callId?: string;
  name?: string;
  verb?: string;
  input?: Record<string, unknown>;
  content?: string;
  ok?: boolean;
  complete: boolean;
}

/** Reconstruct exactly the same ordered transcript on refresh and reconnect. */
export function projectConversation(
  events: Array<{ seq: number; type: string; payload: unknown }>,
  status: string,
) {
  const parts: ConversationPart[] = [];
  let step = 0;
  let finished = !["running", "queued"].includes(status);
  let sequence = -1;
  const textPart = (kind: "text" | "reasoning", seq: number) => {
    const id = `${kind}-${step}`;
    let part = parts.find((p) => p.id === id);
    if (!part) {
      part = { id, kind, step, sequence: seq, text: "", complete: false };
      const index =
        kind === "reasoning"
          ? parts.findIndex((p) => p.id === `text-${step}`)
          : -1;
      if (index >= 0) parts.splice(index, 0, part);
      else parts.push(part);
    }
    part.sequence = seq;
    return part;
  };
  for (const event of events) {
    sequence = Math.max(sequence, event.seq);
    const p = (event.payload ?? {}) as Record<string, unknown>;
    if (typeof p.step === "number") step = p.step;
    if (event.type === "llm_call_started") textPart("text", event.seq);
    if (event.type === "llm_text_delta") {
      textPart("text", event.seq).text +=
        typeof p.text === "string" ? p.text : "";
      const reasoning = parts.find((part) => part.id === `reasoning-${step}`);
      if (reasoning) reasoning.complete = true;
    }
    if (event.type === "llm_reasoning_delta")
      textPart("reasoning", event.seq).text +=
        typeof p.text === "string" ? p.text : "";
    if (event.type === "llm_call_finished") {
      const text = textPart("text", event.seq);
      text.text = typeof p.text === "string" ? p.text : "";
      text.complete = true;
      const usage = p.usage as { reasoningTokens?: number } | undefined;
      if (
        typeof p.reasoning === "string" ||
        usage?.reasoningTokens !== undefined
      ) {
        const reasoning = textPart("reasoning", event.seq);
        if (typeof p.reasoning === "string") reasoning.text = p.reasoning;
        reasoning.reasoningTokens = usage?.reasoningTokens;
      }
      const reasoning = parts.find((part) => part.id === `reasoning-${step}`);
      if (reasoning) reasoning.complete = true;
    }
    if (event.type === "tool_call" || event.type === "tool_result") {
      const name = typeof p.name === "string" ? p.name : "tool";
      const callId = typeof p.callId === "string" ? p.callId : undefined;
      let part =
        event.type === "tool_result"
          ? parts.find(
              (part) =>
                part.kind === "tool" &&
                part.step === step &&
                (callId
                  ? part.callId === callId
                  : part.name === name && !part.complete),
            )
          : undefined;
      if (!part) {
        const input =
          p.input && typeof p.input === "object"
            ? (p.input as Record<string, unknown>)
            : {};
        part = {
          id: callId ? `tool-${step}-${callId}` : `tool-${event.seq}`,
          callId,
          kind: "tool",
          name,
          verb: typeof p.verb === "string" ? p.verb : toolVerb(name, input),
          step,
          sequence: event.seq,
          input,
          complete: false,
        };
        parts.push(part);
      }
      part.sequence = event.seq;
      if (typeof p.verb === "string") part.verb = p.verb;
      if (event.type === "tool_result") {
        part.complete = true;
        part.ok = p.ok === true;
        part.content =
          typeof p.content === "string" ? p.content.slice(0, 4000) : "";
      }
    }
    if (event.type === "run_finished") {
      finished = true;
      const summary = typeof p.summary === "string" ? p.summary.trim() : "";
      const lastText = parts
        .filter((p) => p.kind === "text" && p.text?.trim())
        .at(-1)
        ?.text?.trim();
      if (summary && summary !== lastText)
        parts.push({
          id: "final",
          kind: "text",
          step,
          sequence: event.seq,
          text: summary,
          complete: true,
        });
    }
  }
  if (finished) for (const part of parts) part.complete = true;
  return { parts, sequence, finished };
}
