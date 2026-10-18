/** Tiny typed fetch wrapper — same-origin (Vite proxies to :8787 in dev). */
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    credentials: "include",
    ...init,
    headers: {
      ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(res.status, body.error ?? `request failed (${res.status})`);
  }
  return (await res.json()) as T;
}

// --- auth + onboarding ---------------------------------------------------------

export interface SessionUser {
  id: string;
  email: string | null;
  login: string | null;
  name: string | null;
  avatarUrl: string | null;
}

export interface OnboardingData {
  user: SessionUser;
  githubAppConfigured: boolean;
  installations: Array<{
    installationId: number;
    accountLogin: string;
    suspended: boolean;
    repos: Array<{ fullName: string; enabled: boolean; defaultBranch: string | null }>;
  }>;
}

// --- the dashboard -----------------------------------------------------------------

export interface RunSummary {
  id: string;
  status: string;
  trigger: string;
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

/** Live run projections, streamed over SSE (`event: live`). */
export interface LiveEvent {
  threadId: string;
  runId: string;
  kind:
    | "llm_started"
    | "delta"
    | "assistant_done"
    | "tool_call"
    | "tool_result"
    | "phase"
    | "guardrail"
    | "run_finished"
    | "error";
  text?: string;
  phase?: string | null;
  step?: number;
  name?: string;
  ok?: boolean;
  content?: string;
  summary?: string | null;
  disposition?: string | null;
  reason?: string;
  message?: string;
  guardrail?: string;
  detail?: string;
  via?: string | null;
  tools?: string[];
}

export const getThreads = () => api<{ threads: ThreadListItem[] }>("/api/threads");
export const getThread = (id: string) => api<ThreadDetail>(`/api/threads/${id}`);
export const getRun = (id: string) => api<RunDetail>(`/api/runs/${id}`);
export const cancelRun = (id: string) =>
  api<{ ok: boolean; action: string }>(`/api/runs/${id}/cancel`, { method: "POST" });
export const keepSandbox = (id: string) =>
  api<{ ok: boolean }>(`/api/runs/${id}/keep-sandbox`, { method: "POST" });
export const interjectEvent = (id: string) =>
  api<{ ok: boolean; action: string }>(`/api/events/${id}/interject`, { method: "POST" });
export const postMessage = (threadId: string, text: string) =>
  api<{ ok: boolean; eventId: string; interjected: boolean; runId: string | null }>(
    `/api/threads/${threadId}/messages`,
    { method: "POST", body: JSON.stringify({ text }) },
  );
