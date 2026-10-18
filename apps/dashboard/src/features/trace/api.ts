/**
 * Trace surface — the WHOLE thread in one payload (LangSmith-style view).
 */
import { api } from "@/utils/api-client";
import type { RunSummary, ThreadSummary } from "@/features/threads/api";

export interface TraceSpan {
  id: string;
  runId: string;
  seq: number;
  type: string;
  payload: Record<string, unknown>;
  ts: string;
}

export interface TraceRun extends RunSummary {
  steps: number;
  tokensIn: number;
  tokensOut: number;
  usd: string;
  keepSandbox: boolean;
}

export interface ThreadTraceTotals {
  runs: number;
  codingRuns: number;
  chatRuns: number;
  tokensIn: number;
  tokensOut: number;
  usd: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface ThreadTrace {
  thread: ThreadSummary;
  totals: ThreadTraceTotals;
  runs: TraceRun[];
  spans: TraceSpan[];
}

export const getThreadTrace = (id: string) =>
  api<ThreadTrace>(`/api/threads/${id}/trace`);
