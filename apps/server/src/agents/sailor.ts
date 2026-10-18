import { codingAgent, type Agent, type Tool } from "@anchor/core";
import { buildSailorPrompt } from "./prompts.js";

/** Sailor is the reusable coding agent configured for this product. Same
 * phases, judgment and loop; only identity, context and app tools specialize it. */
export function createSailorAgent(
  context: string,
  productTools: Tool[] = [],
): Agent {
  return {
    name: "sailor",
    tools: [...codingAgent.tools, ...productTools],
    strategy: {
      ...codingAgent.strategy,
      name: "sailor",
      systemPrompt: (args) =>
        buildSailorPrompt(
          [context, args.context].filter(Boolean).join("\n\n"),
          args.summary,
        ),
    },
  };
}
