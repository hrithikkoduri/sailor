/**
 * Abortable tools: a stop or interjection ends the run now, not after the
 * current shell command or file read returns.
 *
 * The engine checks `signal` before starting the next call but awaits a tool
 * that is already running. This wrapper races each tool against the run's
 * abort signal, so the loop can conclude "cancelled" immediately.
 *
 * The underlying sandbox process is not killed by this race; it finishes on
 * its own deadline. Killing it requires cancellation in the sandbox adapter
 * (Anchor/Sandbox exec), not the engine.
 */
import type { Tool, ToolResult } from "anchor-ai-sdk";

const cancelled = (): ToolResult => ({
  ok: false,
  content: "Not executed: the run was cancelled.",
});

export function abortableTool(tool: Tool, signal: AbortSignal): Tool {
  return {
    ...tool,
    run: async (input, ctx) => {
      if (signal.aborted) return cancelled();
      let onAbort: (() => void) | undefined;
      const aborted = new Promise<ToolResult>((resolve) => {
        onAbort = () => resolve(cancelled());
        signal.addEventListener("abort", onAbort, { once: true });
      });
      const running = tool.run(input, ctx);
      // If the abort wins, the tool's eventual rejection must not surface as
      // an unhandled rejection in the worker.
      running.catch(() => undefined);
      try {
        return await Promise.race([running, aborted]);
      } finally {
        if (onAbort) signal.removeEventListener("abort", onAbort);
      }
    },
  };
}
