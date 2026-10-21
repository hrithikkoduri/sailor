/** Threads surface: the list, one thread's detail, and its small actions. */
import { api } from "@/utils/api-client";
import type { RunConversation } from "@/features/chat/types";

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
  conversation?: RunConversation;
  /** The run's final assistant text (its "message" in the conversation). */
  agentText: string | null;
}

export interface ThreadSummary {
  id: string;
  title?: string | null;
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
  thread: ThreadSummary & {
    installationAccount: string | null;
    issueUrl: string | null;
  };
  runs: ThreadRun[];
  events: ThreadEventRow[];
  pendingEvents: PendingEvent[];
  questions?: QuestionRequest[];
}

export interface QuestionRequest {
  id: string;
  title: string;
  status: string;
  questions: Array<{ id: string; label: string; description?: string; required: boolean;
    type: "text" | "single_select" | "multi_select" | "repository";
    options?: Array<{ value: string; label: string }>; recommended?: string }>;
  answers: Record<string, string | string[]> | null;
  createdAt: string;
}

export const createThread = (text: string, repo?: string) =>
  api<{ thread: ThreadSummary; runId: string }>("/api/threads", { method: "POST", body: JSON.stringify({ text, repo }) });
export const deleteThread = (id: string) =>
  api<{ ok: boolean }>(`/api/threads/${id}`, { method: "DELETE" });
export const renameThread = (id: string, title: string) =>
  api<{ ok: boolean; title: string }>(`/api/threads/${id}`, { method: "PATCH", body: JSON.stringify({ title }) });
export const attachThreadRepository = (id: string, repository: string) =>
  api<{ ok: boolean; queued: boolean; runId: string | null }>(`/api/threads/${id}/repository`, { method: "POST", body: JSON.stringify({ repository }) });
export const switchThreadRepository = (id: string, repository: string) =>
  api<{ ok: boolean; runId: string }>(`/api/threads/${id}/repository/switch`, { method: "POST", body: JSON.stringify({ repository }) });
export const answerQuestions = (id: string, answers: Record<string, string | string[]>) =>
  api<{ ok: boolean; runId: string }>(`/api/questions/${id}/answers`, { method: "POST", body: JSON.stringify({ answers }) });

export interface TraceRow {
  id: string; threadId: string; title: string | null; repo: string; task: string | null;
  status: string; steps: number; tokensIn: number; tokensOut: number; usd: string;
  createdAt: string; startedAt: string | null; finishedAt: string | null;
}
export const getTraces = (page = 0) => api<{ traces: TraceRow[]; hasMore: boolean; page: number }>(`/api/traces?page=${page}`);

export function threadTitle(thread: ThreadListItem | ThreadSummary): string {
  return thread.title ?? ("latestRun" in thread ? thread.latestRun?.task?.match(/^Fix GitHub issue #\d+: ([^\n]+)/)?.[1] : undefined)
    ?? (thread.source === "github" ? `Issue #${thread.issueNumber}` : "Untitled thread");
}
export function repositoryLabel(repo: string): string {
  return repo.startsWith("workspace:") ? "Fresh workspace" : repo;
}

export const getThreads = () =>
  api<{ threads: ThreadListItem[] }>("/api/threads");
export const getThread = (id: string) =>
  api<ThreadDetail>(`/api/threads/${id}`, { signal: AbortSignal.timeout(10000) });
export const cancelRun = (id: string) =>
  api<{ ok: boolean; action: string }>(`/api/runs/${id}/cancel`, {
    method: "POST",
  });
export const keepSandbox = (id: string) =>
  api<{ ok: boolean }>(`/api/runs/${id}/keep-sandbox`, { method: "POST" });
