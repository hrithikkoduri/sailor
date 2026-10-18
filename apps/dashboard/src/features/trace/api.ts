/** Trace surface: one run's full timeline. */
import { api } from "@/utils/api-client";
import type { RunSummary } from "@/features/threads/api";

export interface TraceRow {
  id: string;
  seq: number;
  type: string;
  payload: Record<string, unknown>;
  ts: string;
}

export interface RunDetail {
  run: RunSummary & {
    startPhase: string | null;
    steps: number;
    tokensIn: number;
    tokensOut: number;
    usd: string;
    keepSandbox: boolean;
    cancelRequestedAt: string | null;
    heartbeatAt: string | null;
  };
  trace: TraceRow[];
}

export const getRun = (id: string) => api<RunDetail>(`/api/runs/${id}`);
