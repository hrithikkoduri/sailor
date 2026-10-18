/**
 * ThreadDetailPage — the conversation view.
 *
 * Chat tab (default): conversation + composer; live runs stream into a
 * bubble via `useThreadStream`. Trace tab (`?run=`) renders one run's full
 * timeline — the PR trace link lands here. The rail holds context, runs,
 * and pending events with explicit Interject.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { ChevronLeft, ExternalLink, GitPullRequest } from "lucide-react";
import { AppShell } from "@/features/shell/app-shell";
import { Conversation } from "@/features/chat/conversation";
import { ChatComposer } from "@/features/chat/components/composer";
import { useThreadStream } from "@/features/chat/use-thread-stream";
import { emptyLive } from "@/features/chat/live";
import { interjectEvent, postMessage } from "@/features/chat/api";
import { ContextRail } from "@/features/threads/components/context-rail";
import { RunPanel } from "@/features/trace/run-panel";
import { cancelRun, getThread, keepSandbox, type ThreadDetail } from "@/features/threads/api";
import { getRun, type RunDetail } from "@/features/trace/api";
import { StatusPill } from "@/elements/status-pill";
import { useAction } from "@/hooks/use-action";
import { ApiError } from "@/utils/api-client";
import { cn } from "@/utils/cn";

const TERMINAL = new Set(["merged", "closed", "abandoned"]);

export function ThreadDetailPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const runParam = params.get("run");

  const [detail, setDetail] = useState<ThreadDetail | null>(null);
  const [runDetail, setRunDetail] = useState<RunDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const { busy, error, run } = useAction();

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
      else setLoadError("Could not load this thread.");
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

  const { live, setLive } = useThreadStream(id, () => {
    void refetch();
    void refetchRun();
  });

  useEffect(() => {
    void refetch();
  }, [refetch]);

  useEffect(() => {
    void refetchRun();
  }, [selectedRunId, refetchRun]);

  // Hydrate the live bubble the moment we know a run is active (before its
  // first streamed event arrives).
  useEffect(() => {
    if (!detail || live) return;
    const active = detail.runs.find((r) => r.status === "running");
    if (active) setLive(emptyLive(active.id, active.phase));
  }, [detail, live, setLive]);

  const act = async (key: string, fn: () => Promise<unknown>) => {
    if (await run(key, fn)) {
      await refetch();
      await refetchRun();
    }
  };

  if (!detail) {
    return (
      <AppShell>
        <p className="p-6 text-sm text-muted-foreground">{loadError ?? "Loading…"}</p>
      </AppShell>
    );
  }

  const { thread, runs, pendingEvents } = detail;
  const activeRun = runs.find((r) => r.status === "running" || r.status === "queued");
  const isTerminal = TERMINAL.has(thread.state);
  const shownError = error ?? loadError;

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
                {activeRun.agent === "chat"
                  ? activeRun.status === "running"
                    ? "replying…"
                    : "queued"
                  : activeRun.status === "running"
                    ? `running · ${activeRun.phase ?? "…"}`
                    : "queued"}
              </span>
            )}
          </div>

          {shownError && (
            <div className="mx-4 mt-3 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-red-300">
              {shownError}
            </div>
          )}

          {runParam ? (
            <div className="min-h-0 flex-1 overflow-y-auto">
              <div className="mx-auto w-full max-w-3xl px-4 py-6">
                {runDetail && runDetail.run.id === runParam ? (
                  <RunPanel runDetail={runDetail} />
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

        <ContextRail
          detail={detail}
          selectedRunId={runParam}
          busy={busy}
          onSelectRun={(runId) => setParams({ run: runId }, { replace: true })}
          onCancel={(runId) => void act(`cancel-${runId}`, () => cancelRun(runId))}
          onKeep={(runId) => void act(`keep-${runId}`, () => keepSandbox(runId))}
          onInterject={(event) => void act(`event-${event.id}`, () => interjectEvent(event.id))}
        />
      </div>
    </AppShell>
  );
}
