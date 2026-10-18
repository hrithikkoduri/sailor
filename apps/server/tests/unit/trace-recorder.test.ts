/**
 * Persistence-boundary redaction: the NDJSON sink and the DB journal must
 * apply the same rules — folding previews and summaries can quote tool output.
 */
import { describe, expect, it } from "vitest";
import { TraceRecorder } from "../../src/trace/store.js";
import type { Db } from "../../src/db/index.js";

describe("TraceRecorder", () => {
  it("redacts token-shaped values before the DB journal write", async () => {
    let captured: Record<string, unknown> | undefined;
    const db = {
      insert: () => ({
        values: async (value: Record<string, unknown>) => {
          captured = value;
        },
      }),
    } as unknown as Db;
    const recorder = new TraceRecorder({ db, runId: "run-1" });
    const token = `ghs_${"b".repeat(30)}`;
    await recorder.record({
      type: "error",
      message: `auth failed with ${token}`,
    });
    expect(JSON.stringify(captured)).not.toContain(token);
    expect((captured!.payload as { message: string }).message).toContain(
      "[REDACTED]",
    );
  });
});
