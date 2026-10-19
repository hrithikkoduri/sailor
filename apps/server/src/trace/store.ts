/**
 * TraceRecorder — the product's durable journal (trace_events rows).
 *
 * A TraceSink: entries arrive from a TraceFanout already sequenced and
 * redacted, so the file and the database always agree on ordering, and no
 * persistence path can forget redaction (decision #15's durable replay).
 *
 * DB writes need a runId (a `runs` row), which only exists when a thread
 * context does — CLI-only runs trace to the NDJSON file alone.
 *
 * `afterRecord` runs inside this sink's chain, after the row is in: product
 * bookkeeping (live usage, runs row, dashboard nudge) rides the same order,
 * so a refresh triggered by a nudge always sees the row it would read.
 */
import type { TraceSink, TracedEvent } from "anchor-ai-sdk";
import { schema, type Db } from "../db/index.js";

export class TraceRecorder implements TraceSink {
  readonly name = "db";
  private recorded = 0;

  constructor(
    private readonly targets: {
      db: Db;
      runId: string;
      afterRecord?: (entry: TracedEvent) => void | Promise<void>;
    },
  ) {}

  /** How many events have been recorded. */
  get events(): number {
    return this.recorded;
  }

  async record(entry: TracedEvent): Promise<void> {
    await this.targets.db.insert(schema.traceEvents).values({
      runId: this.targets.runId,
      seq: entry.seq,
      type: entry.event.type,
      // Already redacted by the fanout — the entry is the payload contract.
      payload: entry.event as unknown as Record<string, unknown>,
    });
    this.recorded += 1;
    await this.targets.afterRecord?.(entry);
  }
}
