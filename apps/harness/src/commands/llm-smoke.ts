/**
 * `harness llm smoke` — live proof of the LLM client:
 *   1. text round-trip (reply, latency, usage, cost when pricing is set)
 *   2. tool-call round-trip (the model must call a tiny tool; the arguments
 *      must be valid JSON)
 * Exit code 0 means the client works end-to-end against the configured model.
 */
import { loadConfig } from "../config.js";
import { createLLMClient } from "@harness/agent";

export async function llmSmokeCommand(): Promise<number> {
  const cfg = loadConfig();
  const llm = createLLMClient(cfg.llm);
  process.stdout.write(`\nllm smoke — ${cfg.llm.baseUrl}\n  model: ${llm.model}\n\n`);

  const t0 = Date.now();
  try {
    // 1. Text round-trip. Budget note: reasoning models spend completion
    //    tokens on chain-of-thought before emitting text — too small a
    //    max_tokens yields an empty reply and finish_reason "length".
    const text = await llm.complete({
      messages: [
        { role: "system", content: "Reply with exactly one word: PONG" },
        { role: "user", content: "ping" },
      ],
      maxTokens: 128,
    });
    const cost = text.usage.costUsd !== undefined ? `, $${text.usage.costUsd.toFixed(5)}` : "";
    process.stdout.write(
      `→ text round-trip: ${text.latencyMs}ms, ${text.usage.totalTokens} tokens${cost}\n`,
    );
    process.stdout.write(`  reply: ${JSON.stringify(text.text.trim().slice(0, 60))}\n`);
    process.stdout.write(`  finish: ${text.finishReason ?? "?"}\n`);
    if (text.text.trim() === "") {
      process.stderr.write(`  ✗ empty text (finish: ${text.finishReason ?? "?"})\n`);
      return 1;
    }

    // 2. Tool-call round-trip.
    const tool = await llm.complete({
      messages: [
        { role: "system", content: "You must use the get_weather tool to answer." },
        { role: "user", content: "What is the weather in Paris?" },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "get_weather",
            description: "Get the current weather for a city",
            parameters: {
              type: "object",
              properties: { city: { type: "string", description: "City name" } },
              required: ["city"],
            },
          },
        },
      ],
      maxTokens: 256,
    });
    process.stdout.write(`→ tool-call round-trip: ${tool.latencyMs}ms, ${tool.usage.totalTokens} tokens\n`);
    if (tool.toolCalls.length === 0) {
      process.stderr.write(
        `  ✗ no tool calls returned (text: ${JSON.stringify(tool.text.slice(0, 120))})\n`,
      );
      return 1;
    }
    for (const call of tool.toolCalls) {
      process.stdout.write(`  call: ${call.name}(${call.arguments})\n`);
      JSON.parse(call.arguments); // must be valid JSON
    }

    process.stdout.write(`\nLLM SMOKE PASSED in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`\nLLM SMOKE FAILED: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}
