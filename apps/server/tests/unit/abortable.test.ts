import { describe, expect, it, vi } from "vitest";
import type { Tool } from "anchor-ai-sdk";
import { abortableTool } from "../../src/services/runs/abortable.js";

const hangingTool = (): Tool => ({
  definition: { name: "bash", description: "run", parameters: {} },
  run: () => new Promise(() => undefined),
});

describe("abortable tools", () => {
  it("returns immediately when the run is cancelled", async () => {
    const controller = new AbortController();
    const tool = abortableTool(hangingTool(), controller.signal);
    const running = tool.run({}, {});
    controller.abort();
    await expect(running).resolves.toMatchObject({ ok: false, content: expect.stringMatching(/cancelled/) });
  });

  it("does not start a tool after the run is already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const run = vi.fn();
    const tool = abortableTool({ ...hangingTool(), run }, controller.signal);
    await expect(tool.run({}, {})).resolves.toMatchObject({ ok: false });
    expect(run).not.toHaveBeenCalled();
  });

  it("passes a normal result through untouched", async () => {
    const tool = abortableTool({
      definition: { name: "read_file", description: "read", parameters: {} },
      run: async () => ({ ok: true, content: "hello" }),
    }, new AbortController().signal);
    await expect(tool.run({}, {})).resolves.toEqual({ ok: true, content: "hello" });
  });
});
