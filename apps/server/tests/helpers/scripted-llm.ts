/**
 * A scripted LLM for tests — responses come from a queue, requests recorded.
 * App-side tests use it to drive executeRun/the worker without network.
 */
import type { LLMClient, LLMRequest, LLMResponse } from "@anchor/core";

export type Scripted = {
  text?: string;
  tools?: Array<{ name: string; arguments: string }>;
  /** Per-turn usage overrides — e.g. costUsd to make dollar caps bind. */
  usage?: Partial<{
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    costUsd: number;
    reasoningTokens: number;
  }>;
};

export function scriptedLLM(
  queue: Scripted[],
): LLMClient & { seen: LLMRequest[] } {
  const seen: LLMRequest[] = [];
  const next = (): LLMResponse => {
    const item = queue.shift();
    if (!item) throw new Error("scripted LLM ran out of responses");
    return {
      text: item.text ?? "",
      toolCalls: (item.tools ?? []).map((t, i) => ({
        id: `call_${i}_${seen.length}`,
        name: t.name,
        arguments: t.arguments,
      })),
      usage: {
        promptTokens: 100,
        completionTokens: 10,
        totalTokens: 110,
        ...(item.usage ?? {}),
      },
      model: "scripted",
      finishReason: "stop",
      latencyMs: 1,
    };
  };
  return {
    model: "scripted",
    seen,
    complete: async (req) => {
      seen.push(structuredClone(req));
      return next();
    },
    stream: async (req, onDelta) => {
      seen.push(structuredClone(req));
      const r = next();
      if (r.text) onDelta(r.text);
      return r;
    },
  };
}

/** The fixture fix as agent-chosen work; no phase or finish ceremony required. */
export const FIX_FIXTURE_SCRIPT: Scripted[] = [
  { tools: [{ name: "run_tests", arguments: "{}" }] }, // fails — reproduce evidence
  {
    tools: [
      {
        name: "edit_file",
        arguments: JSON.stringify({
          path: "src/sum.js",
          old_string:
            "numbers.filter((n) => n >= 0).reduce((a, b) => a + b, 0)",
          new_string: "numbers.reduce((a, b) => a + b, 0)",
        }),
      },
    ],
  },
  { tools: [{ name: "run_tests", arguments: "{}" }] }, // full suite passes
  { text: "fixed negatives; the existing test suite passes" },
];
