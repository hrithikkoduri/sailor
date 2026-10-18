/**
 * TraceRecorder — the product's trace persistence.
 *
 * The engine's event stream becomes two durable artifacts with ONE sequence
 * number, so the file and the database always agree on ordering:
 *   - an NDJSON file per run (`traces/<run-id>.jsonl` — the PR trace link)
 *   - rows in `trace_events` (the journal durable resume replays, decision #15)
 *
 * DB writes need a runId (a `runs` row), which only exists when a thread
 * context does — CLI-only runs write the file alone; worker runs (step 10)
 * write both.
 */
import { JsonlTrace, type AgentEvent } from "@anchor/core";
import { schema, type Db } from "../db/index.js";

export interface TraceTargets {
  jsonl?: JsonlTrace;
  db?: Db;
  runId?: string;
}

export class TraceRecorder {
  private fallbackSeq = 0;
  private recorded = 0;

  constructor(private readonly targets: TraceTargets = {}) {}

  /** How many events have been recorded. */
  get events(): number {
    return this.recorded;
  }

  async record(event: AgentEvent): Promise<void> {
    let seq: number;
    if (this.targets.jsonl) {
      seq = await this.targets.jsonl.record(event);
    } else {
      seq = this.fallbackSeq++;
    }

    if (this.targets.db && this.targets.runId) {
      await this.targets.db.insert(schema.traceEvents).values({
        runId: this.targets.runId,
        seq,
        type: event.type,
        payload: event as unknown as Record<string, unknown>,
      });
    }

    this.recorded += 1;
  }
}
