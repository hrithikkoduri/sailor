/**
 * ThreadDetailPage — one thread: its runs, its pending events, the live trace.
 *
 * The PR's trace link (`/threads/:id?run=:runId`) lands here with the run
 * preselected. SSE nudges (stream.ts) trigger debounced refetches — the UI
 * always renders what Postgres says, never a client-side model of it.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  ApiError,
  cancelRun,
  getRun,
  getThread,
  interjectEvent,
  keepSandbox,
  type PendingEvent,
  type RunDetail,
  type ThreadDetail,
} from "../api";
import { Shell } from "../components/Shell";
import { TraceView } from "../components/TraceView";
import { duration, fmtTokens, fmtUsd, RunStatusPill, StatePill, timeAgo } from "../components/badges";

const ACTIVE_RUN_STATUSES = new Set(["queued", "running"]);

export function ThreadDetailPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const runParam = params.get("run");

  const [detail, setDetail] = useState<ThreadDetail | null>(null);
  const [runDetail, setRunDetail] = useState<RunDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const selectedRunId = runParam ?? detail?.runs[0]?.id ?? null;
  const selectedRunIdRef = useRef<string | null>(null);
  selectedRunIdRef.current = selectedRunId;

  const refetch = useCallback(async () => {
    try {
      setDetail(await getThread(id));
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) navigate("/login");
      else setError("Could not load this thread.");
    }
  }, [id, navigate]);

  const refetchRun = useCallback(async () => {
    const runId = selectedRunIdRef.current;
    if (!runId) return;
    try {
      setRunDetail(await getRun(runId));
    } catch {
      /* transient */
    }
  }, []);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  useEffect(() => {
    if (!selectedRunId) {
      setRunDetail(null);
      return;
    }
    void refetchRun();
  }, [selectedRunId, refetchRun]);

  // Live updates: SSE nudge → debounced refetch of the thread + visible run.
  useEffect(() => {
    const es = new EventSource(`/api/threads/${id}/stream`);
    let timer: number | undefined;
    es.addEventListener("update", () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        void refetch();
        void refetchRun();
      }, 250);
    });
    return () => {
      window.clearTimeout(timer);
      es.close();
    };
  }, [id, refetch, refetchRun]);

  const act = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
      await refetch();
      await refetchRun();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Action failed — try again.");
    } finally {
      setBusy(null);
    }
  };

  if (!detail) {
    return (
      <Shell max="max-w-6xl">
        <p className="text-sm text-zinc-500">{error ?? "Loading…"}</p>
      </Shell>
    );
  }

  const { thread, runs, pendingEvents } = detail;
  const activeRun = runs.find((r) => ACTIVE_RUN_STATUSES.has(r.status));

  return (
    <Shell max="max-w-6xl">
      <Link to="/" className="text-sm text-zinc-500 transition hover:text-zinc-300">
        ← All threads
      </Link>

      {/* header */}
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">{thread.repo}</h1>
        <span className="font-mono text-sm text-zinc-500">#{thread.issueNumber}</span>
        <StatePill state={thread.state} />
        <div className="ml-auto flex items-center gap-2">
          {thread.issueUrl && (
            <a href={thread.issueUrl} target="_blank" className="rounded-lg border border-white/10 bg-white/[0.03] px-3 py-1.5 text-sm text-zinc-300 transition hover:bg-white/[0.07]">
              Issue ↗
            </a>
          )}
          {thread.prUrl && (
            <a href={thread.prUrl} target="_blank" className="rounded-lg border border-emerald-400/40 bg-emerald-500/10 px-3 py-1.5 text-sm text-emerald-200 transition hover:bg-emerald-500/20">
              PR #{thread.prNumber} ↗
            </a>
          )}
        </div>
      </div>

      {/* meta */}
      <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-xs text-zinc-500">
        {thread.phase && <span>phase: {thread.phase}</span>}
        <span>
          turns {thread.turnsUsed}/{thread.budgetMaxTurns}
        </span>
        <span>
          {fmtUsd(thread.usdSpent)} of {fmtUsd(thread.budgetMaxUsd)}
        </span>
        {thread.installationAccount && <span>installed by {thread.installationAccount}</span>}
        {thread.checkpointSha && <span className="font-mono">checkpoint {thread.checkpointSha.slice(0, 8)}</span>}
        <span>updated {timeAgo(thread.updatedAt)}</span>
      </div>

      {error && (
        <div className="mt-4 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-2.5 text-sm text-red-300">{error}</div>
      )}

      {/* pending events — the interject surface */}
      {pendingEvents.length > 0 && (
        <section className="mt-6">
          <h2 className="text-xs font-semibold tracking-widest text-zinc-400 uppercase">
            Pending events ({pendingEvents.length})
          </h2>
          <div className="mt-3 space-y-2">
            {pendingEvents.map((event) => (
              <PendingEventCard
                key={event.id}
                event={event}
                busy={busy === `event-${event.id}`}
                onInterject={() => void act(`event-${event.id}`, () => interjectEvent(event.id))}
              />
            ))}
          </div>
          <p className="mt-2 text-xs text-zinc-600">
            Interject forces the pending event in: the active run stops at its next boundary and this becomes the next turn.
          </p>
        </section>
      )}

      {/* active run actions */}
      {activeRun && (
        <section className="mt-6 flex flex-wrap items-center gap-3 rounded-xl border border-indigo-400/30 bg-indigo-500/[0.07] px-4 py-3">
          <RunStatusPill status={activeRun.status} />
          <span className="text-sm text-zinc-300">
            {activeRun.status === "running" ? "Agent is working" : "Run queued — waiting for the worker"}
            {activeRun.phase ? ` (${activeRun.phase})` : ""}
          </span>
          <div className="ml-auto flex gap-2">
            <button
              onClick={() => void act(`keep-${activeRun.id}`, () => keepSandbox(activeRun.id))}
              disabled={busy !== null}
              className="rounded-lg border border-white/10 bg-white/[0.04] px-3 py-1.5 text-sm text-zinc-300 transition hover:bg-white/[0.08] disabled:opacity-50"
            >
              Keep sandbox
            </button>
            <button
              onClick={() => void act(`cancel-${activeRun.id}`, () => cancelRun(activeRun.id))}
              disabled={busy !== null}
              className="rounded-lg border border-amber-400/40 bg-amber-500/10 px-3 py-1.5 text-sm text-amber-200 transition hover:bg-amber-500/20 disabled:opacity-50"
            >
              Cancel run
            </button>
          </div>
        </section>
      )}

      <div className="mt-8 grid grid-cols-1 gap-6 lg:grid-cols-[280px_1fr]">
        {/* runs */}
        <aside>
          <h2 className="text-xs font-semibold tracking-widest text-zinc-400 uppercase">Runs ({runs.length})</h2>
          <div className="mt-3 space-y-2">
            {runs.map((run) => (
              <button
                key={run.id}
                onClick={() => setParams(run.id === detail.runs[0]?.id ? {} : { run: run.id }, { replace: true })}
                className={`w-full rounded-xl border px-4 py-3 text-left transition ${
                  selectedRunId === run.id
                    ? "border-indigo-400/50 bg-indigo-500/[0.1]"
                    : "border-white/10 bg-white/[0.02] hover:bg-white/[0.05]"
                }`}
              >
                <div className="flex items-center gap-2">
                  <RunStatusPill status={run.status} />
                </div>
                <div className="mt-1.5 text-xs text-zinc-500">
                  {run.trigger} · {timeAgo(run.createdAt)}
                </div>
                {run.error && <div className="mt-1 truncate text-xs text-red-300/80">{run.error}</div>}
              </button>
            ))}
          </div>
        </aside>

        {/* the selected run's story */}
        <section className="min-w-0">
          {runDetail && runDetail.run.id === selectedRunId ? (
            <>
              <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-xs text-zinc-500">
                <span className="font-mono text-zinc-400">run {runDetail.run.id.slice(0, 8)}</span>
                <span>{runDetail.run.steps} steps</span>
                <span>
                  ↑ {fmtTokens(runDetail.run.tokensIn)} ↓ {fmtTokens(runDetail.run.tokensOut)} tokens
                </span>
                <span>{fmtUsd(runDetail.run.usd)}</span>
                <span>{duration(runDetail.run.startedAt, runDetail.run.finishedAt)}</span>
                {runDetail.run.keepSandbox && (
                  <span className="rounded-full border border-sky-400/40 bg-sky-500/10 px-2 py-0.5 text-sky-200">
                    sandbox kept
                  </span>
                )}
                {runDetail.run.cancelRequestedAt && runDetail.run.status === "running" && (
                  <span className="rounded-full border border-amber-400/40 bg-amber-500/10 px-2 py-0.5 text-amber-200">
                    cancelling…
                  </span>
                )}
              </div>
              {runDetail.run.task && (
                <div className="mt-3 rounded-xl border border-white/10 bg-white/[0.02] p-4 text-sm whitespace-pre-wrap text-zinc-300">
                  {runDetail.run.task}
                </div>
              )}
              <div className="mt-4">
                <TraceView trace={runDetail.trace} />
              </div>
            </>
          ) : (
            <p className="text-sm text-zinc-500">Select a run to see its trace.</p>
          )}
        </section>
      </div>
    </Shell>
  );
}

function PendingEventCard({
  event,
  busy,
  onInterject,
}: {
  event: PendingEvent;
  busy: boolean;
  onInterject: () => void;
}) {
  const p = event.payload as Record<string, unknown>;
  const preview =
    (typeof p.body === "string" && p.body) ||
    (typeof p.title === "string" && `issue #${String(p.number ?? "")}: ${p.title}`) ||
    (typeof p.ref === "string" && `push to ${p.ref}`) ||
    JSON.stringify(p).slice(0, 160);
  const author = typeof p.author === "string" ? p.author : typeof p.sender === "object" && p.sender && typeof (p.sender as { login?: unknown }).login === "string" ? String((p.sender as { login: string }).login) : undefined;

  return (
    <div className="flex items-start justify-between gap-4 rounded-xl border border-amber-400/25 bg-amber-500/[0.05] px-4 py-3">
      <div className="min-w-0">
        <div className="flex items-center gap-2 text-xs text-amber-200/90">
          <span className="font-mono">{event.kind}</span>
          {author && <span>by {author}</span>}
          <span className="text-amber-200/50">{timeAgo(event.receivedAt)}</span>
        </div>
        <div className="mt-1 truncate text-sm text-zinc-300">{String(preview).slice(0, 220)}</div>
      </div>
      <button
        onClick={onInterject}
        disabled={busy}
        className="shrink-0 rounded-lg border border-amber-400/50 bg-amber-500/15 px-3 py-1.5 text-sm text-amber-100 transition hover:bg-amber-500/25 disabled:opacity-50"
      >
        {busy ? "…" : "Interject"}
      </button>
    </div>
  );
}
