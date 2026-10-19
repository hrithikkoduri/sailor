/**
 * TraceRecorder — the DB journal sink. It writes the entry's sequence and
 * type verbatim (ordering belongs to the fanout, never to the sink) and the
 * payload arrives already redacted; `afterRecord` runs after the row lands.
 */
import { describe, expect, it } from "vitest";
import { redactEvent } from "@anchor/core";
import { TraceRecorder } from "../../src/trace/store.js";
import type { Db } from "../../src/db/index.js";

describe("TraceRecorder", () => {
  it("writes the entry's sequence, type, and payload to the journal", async () => {
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
      seq: 7,
      ts: "2026-10-18T00:00:00.000Z",
      event: redactEvent({
        type: "error",
        message: `auth failed with ${token}`,
      }),
    });
    expect(captured).toMatchObject({ runId: "run-1", seq: 7, type: "error" });
    expect(JSON.stringify(captured)).not.toContain(token);
    expect((captured!.payload as { message: string }).message).toContain(
      "[REDACTED]",
    );
    expect(recorder.events).toBe(1);
  });

  it("runs afterRecord after the row is in", async () => {
    const order: string[] = [];
    const db = {
      insert: () => ({
        values: async () => void order.push("row"),
      }),
    } as unknown as Db;
    const recorder = new TraceRecorder({
      db,
      runId: "run-1",
      afterRecord: () => void order.push("after"),
    });
    await recorder.record({
      seq: 0,
      ts: "2026-10-18T00:00:00.000Z",
      event: { type: "run_started", task: "x", phases: [] },
    });
    expect(order).toEqual(["row", "after"]);
  });
});
