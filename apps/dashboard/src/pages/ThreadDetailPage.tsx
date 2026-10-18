/**
 * ThreadDetailPage — the conversation view.
 *
 * Chat tab: humans and the agent, live-streaming while a run works, with the
 * composer at the bottom (Enter queues, double-Enter interjects). Trace tab
 * (`?run=`) renders a run's full timeline — the PR trace link lands here.
 * The rail holds context, runs, and pending events with explicit Interject.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  ChevronLeft,
  ExternalLink,
  GitPullRequest,
  OctagonX,
  Wrench,
  Zap,
} from "lucide-react";
import {
  ApiError,
  cancelRun,
  getRun,
  getThread,
  interjectEvent,
  keepSandbox,
  postMessage,
  type RunDetail,
  type ThreadDetail,
} from "@/api";
import { AppShell } from "@/components/app-shell";
import { applyLiveEvent, Conversation, type LiveState } from "@/components/conversation";
import { ChatComposer } from "@/components/composer";
import { StatusPill } from "@/components/status";
import { TraceView } from "@/components/TraceView";
import { fmtTokens, fmtUsd, duration, shortId, timeAgo } from "@/lib/format";
import { cn } from "@/lib/utils";

const TERMINAL = new Set(["merged", "closed", "abandoned"]);

export function ThreadDetailPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const runParam = params.get("run");

  const [detail, setDetail] = useState<ThreadDetail | null>(null);
  const [live, setLive] = useState<LiveState | null>(null);
  const [runDetail, setRunDetail] = useState<RunDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const selectedRunId = runParam ?? detail?.runs.find((r) => r.status === "running")?.id ?? detail?.runs[0]?.id ?? null;
  const selectedRunIdRef = useRef<string | null>(null);
  selectedRunIdRef.current = selectedRunId;

  const refetch = useCallback(async () => {
    try {
      const next = await getThread(id);
      setDetail(next);
      setLive((prev) => {
        if (!prev) return prev;
        const stillActive = next.runs.some(
          (r) => r.id === prev.runId && (r.status === "running" || r.status === "queued"),
        );
        return stillActive ? prev : null;
      });
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
    void refetchRun();
  }, [selectedRunId, refetchRun]);

  // Live transport: nudges → debounced refetch; payloads → the streaming bubble.
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
    es.addEventListener("live", (ev) => {
      try {
        setLive((prev) => applyLiveEvent(prev, JSON.parse((ev as MessageEvent).data)));
      } catch {
        /* malformed frame */
      }
    });
    return () => {
      window.clearTimeout(timer);
      es.close();
    };
  }, [id, refetch, refetchRun]);

  // Hydrate the live bubble the moment we know a run is active (before its
  // first streamed event arrives).
  useEffect(() => {
    if (!detail || live) return;
    const active = detail.runs.find((r) => r.status === "running");
    if (active) setLive({ runId: active.id, phase: active.phase, text: "", tools: [], startedAt: Date.now() });
  }, [detail, live]);

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
      <AppShell>
        <p className="p-6 text-sm text-muted-foreground">{error ?? "Loading…"}</p>
      </AppShell>
    );
  }

  const { thread, runs, pendingEvents } = detail;
  const activeRun = runs.find((r) => r.status === "running" || r.status === "queued");
  const isTerminal = TERMINAL.has(thread.state);

  return (
    <AppShell
      topbar={
        <div className="flex min-w-0 flex-1 items-center gap-2.5">
          <Link
            to="/"
            className="flex items-center gap-0.5 rounded-md px-1 py-0.5 text-muted-foreground transition-colors hover:text-foreground"
          >
            <ChevronLeft className="size-4" />
          </Link>
          <span className="truncate font-mono text-[12.5px]">
            {thread.repo}
            <span className="text-muted-foreground">#{thread.issueNumber}</span>
          </span>
          <StatusPill status={thread.state} />
          <div className="ml-auto flex shrink-0 items-center gap-2">
            {thread.issueUrl && (
              <a
                href={thread.issueUrl}
                target="_blank"
                className="flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                Issue <ExternalLink className="size-3" />
              </a>
            )}
            {thread.prUrl && (
              <a
                href={thread.prUrl}
                target="_blank"
                className="flex items-center gap-1.5 rounded-lg border border-primary/40 bg-primary/10 px-2.5 py-1 text-xs text-primary transition-colors hover:bg-primary/20"
              >
                <GitPullRequest className="size-3" /> PR #{thread.prNumber}
              </a>
            )}
          </div>
        </div>
      }
    >
      <div className="flex min-h-0 flex-1">
        {/* conversation column */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="flex shrink-0 items-center gap-1 border-b border-border/60 px-4 pt-2 pb-2">
            <button
              onClick={() => setParams({}, { replace: true })}
              className={cn(
                "cursor-pointer rounded-md px-2.5 py-1 text-xs transition-colors",
                !runParam ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              Chat
            </button>
            <button
              onClick={() => selectedRunId && setParams({ run: selectedRunId }, { replace: true })}
              className={cn(
                "cursor-pointer rounded-md px-2.5 py-1 text-xs transition-colors",
                runParam ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              Trace
            </button>
            {activeRun && (
              <span className="ml-auto flex items-center gap-1.5 font-mono text-[10.5px] text-primary">
                <span className="size-1.5 animate-pulse rounded-full bg-primary" />
                {activeRun.status === "running" ? `running · ${activeRun.phase ?? "…"}` : "queued"}
              </span>
            )}
          </div>

          {error && (
            <div className="mx-4 mt-3 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-red-300">
              {error}
            </div>
          )}

          {runParam ? (
            <div className="min-h-0 flex-1 overflow-y-auto">
              <div className="mx-auto w-full max-w-3xl px-4 py-6">
                {runDetail && runDetail.run.id === runParam ? (
                  <>
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[11px] text-muted-foreground">
                      <span className="text-slate-300">run {shortId(runDetail.run.id)}</span>
                      <span>{runDetail.run.steps} steps</span>
                      <span>
                        ↑ {fmtTokens(runDetail.run.tokensIn)} ↓ {fmtTokens(runDetail.run.tokensOut)}
                      </span>
                      <span>{fmtUsd(runDetail.run.usd)}</span>
                      <span>{duration(runDetail.run.startedAt, runDetail.run.finishedAt)}</span>
                      {runDetail.run.keepSandbox && (
                        <span className="rounded-full border border-sky-400/40 bg-sky-400/10 px-2 py-0.5 text-sky-300">
                          sandbox kept
                        </span>
                      )}
                      {runDetail.run.cancelRequestedAt && runDetail.run.status === "running" && (
                        <span className="rounded-full border border-amber-400/40 bg-amber-400/10 px-2 py-0.5 text-amber-300">
                          cancelling…
                        </span>
                      )}
                    </div>
                    {runDetail.run.task && (
                      <div className="mt-3 rounded-xl border border-border/70 bg-card/40 p-4 text-[13px] whitespace-pre-wrap text-slate-300">
                        {runDetail.run.task}
                      </div>
                    )}
                    <div className="mt-4">
                      <TraceView trace={runDetail.trace} />
                    </div>
                  </>
                ) : (
                  <p className="text-sm text-muted-foreground">Loading trace…</p>
                )}
              </div>
            </div>
          ) : (
            <>
              <Conversation
                detail={detail}
                live={live}
                onOpenRun={(runId) => setParams({ run: runId }, { replace: true })}
              />
              <div className="shrink-0 border-t border-border/60 bg-background/85 backdrop-blur">
                <ChatComposer
                  busy={!!activeRun}
                  disabled={isTerminal}
                  onSend={async (text) => {
                    const res = await postMessage(id, text);
                    await refetch();
                    await refetchRun();
                    return { eventId: res.eventId };
                  }}
                />
              </div>
            </>
          )}
        </div>

        {/* context rail */}
        <aside className="hidden w-[320px] shrink-0 overflow-y-auto border-l border-border/60 xl:block">
          <div className="space-y-6 p-5">
            <section>
              <h3 className="font-mono text-[10.5px] tracking-widest text-muted-foreground uppercase">Context</h3>
              <dl className="mt-3 space-y-2 text-xs">
                <RailRow label="Phase" value={thread.phase ?? "—"} mono />
                <RailRow label="Turns" value={`${thread.turnsUsed} / ${thread.budgetMaxTurns}`} />
                <RailRow
                  label="Spend"
                  value={`${fmtUsd(thread.usdSpent)} of ${fmtUsd(thread.budgetMaxUsd)}`}
                />
                {thread.checkpointSha && <RailRow label="Checkpoint" value={shortId(thread.checkpointSha, 10)} mono />}
                {thread.installationAccount && <RailRow label="Installed by" value={thread.installationAccount} />}
                <RailRow label="Updated" value={timeAgo(thread.updatedAt)} />
              </dl>
            </section>

            {activeRun && (
              <section className="rounded-xl border border-primary/25 bg-primary/5 p-4">
                <div className="flex items-center gap-2">
                  <StatusPill status={activeRun.status} />
                  <span className="font-mono text-[11px] text-muted-foreground">{shortId(activeRun.id)}</span>
                </div>
                <div className="mt-3 flex gap-2">
                  <button
                    onClick={() => void act(`keep-${activeRun.id}`, () => keepSandbox(activeRun.id))}
                    disabled={busy !== null}
                    className="flex cursor-pointer items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs text-slate-300 transition-colors hover:bg-accent disabled:opacity-50"
                  >
                    <Wrench className="size-3.5" /> Keep sandbox
                  </button>
                  <button
                    onClick={() => void act(`cancel-${activeRun.id}`, () => cancelRun(activeRun.id))}
                    disabled={busy !== null}
                    className="flex cursor-pointer items-center gap-1.5 rounded-lg border border-amber-400/40 bg-amber-400/10 px-2.5 py-1.5 text-xs text-amber-300 transition-colors hover:bg-amber-400/20 disabled:opacity-50"
                  >
                    <OctagonX className="size-3.5" /> Cancel
                  </button>
                </div>
              </section>
            )}

            <section>
              <h3 className="font-mono text-[10.5px] tracking-widest text-muted-foreground uppercase">
                Runs ({runs.length})
              </h3>
              <div className="mt-3 space-y-1.5">
                {runs.map((run) => (
                  <button
                    key={run.id}
                    onClick={() => setParams({ run: run.id }, { replace: true })}
                    className={cn(
                      "w-full cursor-pointer rounded-lg border px-3 py-2 text-left transition-colors",
                      runParam === run.id
                        ? "border-primary/40 bg-primary/10"
                        : "border-border/70 bg-card/30 hover:bg-card/60",
                    )}
                  >
                    <div className="flex items-center gap-2">
                      <StatusPill status={run.status} />
                      <span className="ml-auto font-mono text-[10.5px] text-muted-foreground">
                        {timeAgo(run.createdAt)}
                      </span>
                    </div>
                    <div className="mt-1 truncate font-mono text-[10.5px] text-muted-foreground">
                      {run.trigger}
                      {run.phase ? ` · ${run.phase}` : ""}
                    </div>
                  </button>
                ))}
              </div>
            </section>

            {pendingEvents.length > 0 && (
              <section>
                <h3 className="font-mono text-[10.5px] tracking-widest text-muted-foreground uppercase">
                  Pending ({pendingEvents.length})
                </h3>
                <div className="mt-3 space-y-2">
                  {pendingEvents.map((event) => {
                    const p = event.payload as Record<string, unknown>;
                    const preview =
                      (typeof p.body === "string" && p.body) ||
                      (typeof p.title === "string" && String(p.title)) ||
                      (typeof p.ref === "string" && `push ${p.ref}`) ||
                      event.kind;
                    return (
                      <div key={event.id} className="rounded-lg border border-border/70 bg-muted/20 px-3 py-2.5">
                        <div className="flex items-center gap-2 font-mono text-[10.5px] text-muted-foreground">
                          <span>{event.kind}</span>
                          <span className="text-muted-foreground/60">{timeAgo(event.receivedAt)}</span>
                        </div>
                        <div className="mt-1 line-clamp-2 text-xs text-slate-300">{String(preview).slice(0, 160)}</div>
                        <button
                          onClick={() => void act(`event-${event.id}`, () => interjectEvent(event.id))}
                          disabled={busy !== null}
                          className="mt-2 flex cursor-pointer items-center gap-1.5 rounded-md border border-amber-400/50 bg-amber-400/15 px-2 py-1 text-[11px] text-amber-100 transition-colors hover:bg-amber-400/25 disabled:opacity-50"
                        >
                          <Zap className="size-3" /> Interject
                        </button>
                      </div>
                    );
                  })}
                </div>
                <p className="mt-2 text-[10.5px] leading-relaxed text-muted-foreground/80">
                  Interjecting stops the active run at its next boundary — the event becomes the next turn.
                </p>
              </section>
            )}
          </div>
        </aside>
      </div>
    </AppShell>
  );
}

function RailRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className={cn("truncate text-right text-slate-300", mono && "font-mono text-[11px]")}>{value}</dd>
    </div>
  );
}
