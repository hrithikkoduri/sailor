/** Threads surface: the list, one thread's detail, and its small actions. */
import { api } from "@/utils/api-client";

export interface RunSummary {
  id: string;
  status: string;
  trigger: string;
  /** Which agent took the turn: "coding" (phase machine) or "chat". */
  agent: string;
  phase: string | null;
  disposition: string | null;
  error: string | null;
  task: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}

export interface ThreadRun extends RunSummary {
  /** The run's final assistant text (its "message" in the conversation). */
  agentText: string | null;
}

export interface ThreadSummary {
  id: string;
  repo: string;
  issueNumber: number;
  state: string;
  source: string;
  prNumber: number | null;
  prUrl: string | null;
  headRef: string | null;
  baseRef: string;
  phase: string | null;
  summary: string | null;
  turnsUsed: number;
  budgetMaxTurns: number;
  usdSpent: string;
  budgetMaxUsd: string;
  checkpointSha: string | null;
  watch: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface ThreadListItem extends ThreadSummary {
  pendingEvents: number;
  latestRun: RunSummary | null;
}

export interface PendingEvent {
  id: string;
  kind: string;
  payload: Record<string, unknown>;
  receivedAt: string;
}

export interface ThreadEventRow {
  id: string;
  kind: string;
  payload: Record<string, unknown>;
  status: string;
  receivedAt: string;
  consumedAt: string | null;
}

export interface ThreadDetail {
  thread: ThreadSummary & { installationAccount: string | null; issueUrl: string | null };
  runs: ThreadRun[];
  events: ThreadEventRow[];
  pendingEvents: PendingEvent[];
}

export const getThreads = () => api<{ threads: ThreadListItem[] }>("/api/threads");
export const getThread = (id: string) => api<ThreadDetail>(`/api/threads/${id}`);
export const cancelRun = (id: string) =>
  api<{ ok: boolean; action: string }>(`/api/runs/${id}/cancel`, { method: "POST" });
export const keepSandbox = (id: string) =>
  api<{ ok: boolean }>(`/api/runs/${id}/keep-sandbox`, { method: "POST" });
