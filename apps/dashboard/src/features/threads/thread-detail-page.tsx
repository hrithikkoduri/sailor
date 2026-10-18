/**
 * ThreadDetailPage — the conversation view.
 *
 * Chat tab (default): conversation + composer; live runs stream into a
 * bubble via `useThreadStream`. Trace tab (`?run=`) opens the WHOLE-THREAD
 * trace explorer with that run focused — the PR trace link lands here.
 * The rail holds context, runs, and pending events with explicit Interject.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { ChevronLeft, ExternalLink, GitPullRequest, OctagonX, Wrench } from "lucide-react";
import { AppShell } from "@/features/shell/app-shell";
import { Conversation } from "@/features/chat/conversation";
import { ChatComposer } from "@/features/chat/components/composer";
import { useThreadStream } from "@/features/chat/use-thread-stream";
import { emptyLive } from "@/features/chat/live";
import { postMessage } from "@/features/chat/api";
import { TraceExplorer } from "@/features/trace/trace-explorer";
import { cancelRun, getThread, keepSandbox, type ThreadDetail } from "@/features/threads/api";
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
  const [traceVersion, setTraceVersion] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const { busy, error, run } = useAction();

  const runParamRef = useRef<string | null>(null);
  runParamRef.current = runParam;

  const refetch = useCallback(async () => {
    try {
      const next = await getThread(id);
      setDetail(next);
      // Live trace: keep the explorer fresh while its tab is open.
      if (runParamRef.current) setTraceVersion((v) => v + 1);
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

  const { live, setLive } = useThreadStream(id, () => {
    void refetch();
  });

  useEffect(() => {
    void refetch();
  }, [refetch]);

  // Hydrate the live bubble the moment we know a run is active (before its
  // first streamed event arrives).
  useEffect(() => {
    if (!detail || live) return;
    const active = detail.runs.find((r) => r.status === "running");
    if (active) setLive(emptyLive(active.id, active.phase));
  }, [detail, live, setLive]);

  const act = async (key: string, fn: () => Promise<unknown>) => {
    if (await run(key, fn)) await refetch();
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
  const latestRunId = activeRun?.id ?? runs[0]?.id ?? null;

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
              onClick={() => latestRunId && setParams({ run: latestRunId }, { replace: true })}
              className={cn(
                "cursor-pointer rounded-md px-2.5 py-1 text-xs transition-colors",
                runParam ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              Trace
            </button>
            {pendingEvents.length > 0 && (
              <span
                title="Waiting to become the next turn"
                className="ml-auto rounded-full border border-amber-400/40 bg-amber-400/10 px-2 py-0.5 font-mono text-[10.5px] text-amber-300"
              >
                {pendingEvents.length} pending
              </span>
            )}
            {activeRun && (
              <span className={`${pendingEvents.length > 0 ? "" : "ml-auto "}flex items-center gap-2 font-mono text-[10.5px] text-primary`}>
                <span className="size-1.5 animate-pulse rounded-full bg-primary" />
                {activeRun.agent === "chat"
                  ? activeRun.status === "running"
                    ? "replying…"
                    : "queued"
                  : activeRun.status === "running"
                    ? `running · ${activeRun.phase ?? "…"}`
                    : "queued"}
                <button
                  onClick={() => void act(`cancel-${activeRun.id}`, () => cancelRun(activeRun.id))}
                  disabled={busy !== null}
                  title="Cancel run"
                  aria-label="Cancel run"
                  className="flex size-5 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-amber-300 disabled:opacity-50"
                >
                  <OctagonX className="size-3" />
                </button>
                <button
                  onClick={() => void act(`keep-${activeRun.id}`, () => keepSandbox(activeRun.id))}
                  disabled={busy !== null}
                  title="Keep sandbox for debugging"
                  aria-label="Keep sandbox"
                  className="flex size-5 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
                >
                  <Wrench className="size-3" />
                </button>
              </span>
            )}
          </div>

          {shownError && (
            <div className="mx-4 mt-3 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-red-300">
              {shownError}
            </div>
          )}

          {runParam ? (
            <TraceExplorer threadId={id} focusRunId={runParam} version={traceVersion} />
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
                    return { eventId: res.eventId };
                  }}
                />
              </div>
            </>
          )}
        </div>
      </div>
    </AppShell>
  );
}
