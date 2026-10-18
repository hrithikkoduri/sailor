import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  Link,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import {
  ArrowLeft,
  ExternalLink,
  GitPullRequest,
  MoreHorizontal,
  Square,
  Workflow,
  MessageSquare,
  ListOrdered,
} from "lucide-react";
import { AppShell } from "@/features/shell/app-shell";
import { Conversation } from "@/features/chat/conversation";
import { ChatComposer } from "@/features/chat/components/composer";
import { PhaseTrail } from "@/features/chat/components/phase-trail";
import { QueuedChip } from "@/features/chat/components/queued-chip";
import { useThreadStream } from "@/features/chat/use-thread-stream";
import { emptyLive, mergeConversation } from "@/features/chat/live";
import { cancelEvent, interjectEvent, postMessage } from "@/features/chat/api";
import { cancelRun, getThread, keepSandbox, type ThreadDetail } from "./api";
import { StatusPill } from "@/elements/status-pill";
import { Button } from "@/elements/button";
import { IconButton } from "@/elements/icon-button";
import { useAction } from "@/hooks/use-action";
import { ApiError } from "@/utils/api-client";
import { eventPreview, payloadStr } from "@/utils/events";
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from "@/components/animate-ui/components/radix/tabs";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/animate-ui/components/radix/dropdown-menu";
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/animate-ui/components/radix/dialog";

const TraceExplorer = lazy(() =>
  import("@/features/trace/trace-explorer").then((m) => ({
    default: m.TraceExplorer,
  })),
);
const TERMINAL = new Set(["merged", "closed", "abandoned"]);

export function ThreadDetailPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const runParam = params.get("run");
  const traceOpen = !!runParam || params.get("view") === "trace";
  const [detail, setDetail] = useState<ThreadDetail | null>(null);
  const [traceVersion, setTraceVersion] = useState(0);
  const [loadError, setLoadError] = useState("");
  const { busy, error, run } = useAction();
  const [interjecting, setInterjecting] = useState(false);
  const [interjectedId, setInterjectedId] = useState<string | null>(null);
  const [landedEventId, setLandedEventId] = useState<string | null>(null);
  const traceOpenRef = useRef(traceOpen);
  const fetching = useRef(false);
  const currentId = useRef(id);
  currentId.current = id;
  traceOpenRef.current = traceOpen;

  const refetch = useCallback(async () => {
    if (fetching.current) return;
    fetching.current = true;
    try {
      const next = await getThread(id);
      if (currentId.current !== id) return;
      setDetail(next);
      setLoadError("");
      if (traceOpenRef.current) setTraceVersion((v) => v + 1);
      setLive((prev) =>
        prev &&
        next.runs.some(
          (r) =>
            r.id === prev.runId && ["running", "queued"].includes(r.status),
        )
          ? prev
          : null,
      );
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) navigate("/login");
      else setLoadError("This conversation could not be loaded.");
    } finally {
      fetching.current = false;
    }
  }, [id, navigate]);
  const { live, setLive } = useThreadStream(
    id,
    () => {
      void refetch();
    },
    detail?.runs.some((r) => ["running", "queued"].includes(r.status)) ?? false,
  );
  useEffect(() => {
    void refetch();
  }, [refetch]);
  useEffect(() => {
    if (!detail || live) return;
    const active = detail.runs.find((r) => r.status === "running");
    if (active) setLive(emptyLive(active.id, active.phase));
  }, [detail, live, setLive]);
  const act = async (key: string, fn: () => Promise<unknown>) => {
    if (await run(key, fn)) await refetch();
  };

  /** Interject the queued dashboard message: stop the run and let the message
   * land in the thread as the next turn. */
  const interjectQueued = async (eventId: string) => {
    setInterjecting(true);
    try {
      if (await run(eventId, () => interjectEvent(eventId))) {
        setInterjectedId(eventId);
        setLandedEventId(eventId);
        await refetch();
      }
    } finally {
      setInterjecting(false);
    }
  };

  /** Withdraw a queued message before any turn picks it up. */
  const cancelQueued = async (eventId: string) => {
    if (await run(eventId, () => cancelEvent(eventId))) {
      if (interjectedId === eventId) setInterjectedId(null);
      await refetch();
    }
  };

  if (!detail)
    return (
      <AppShell>
        <p className="p-8 text-sm text-muted-foreground">
          {loadError || "Loading conversation…"}
        </p>
      </AppShell>
    );
  const { thread, runs, pendingEvents } = detail;
  const queuedChat = pendingEvents.filter((e) => e.kind === "chat_message");
  const queued = queuedChat.at(-1);
  const active = runs.find((r) => ["running", "queued"].includes(r.status));
  const phaseLive = active && live?.runId === active.id ? live : null;
  const phaseTrail = active
    ? mergeConversation(active.conversation, phaseLive)
    : undefined;
  const showPhaseTrail =
    !!active &&
    active.status === "running" &&
    !phaseLive?.finished &&
    (phaseTrail?.phases?.length ?? 0) > 1;
  const initial = detail.events.find((e) => e.kind === "issue_labeled");
  const title =
    typeof initial?.payload.title === "string"
      ? initial.payload.title
      : `Issue #${thread.issueNumber}`;

  return (
    <AppShell
      topbar={
        <>
          <Link
            to="/"
            className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="size-3.5" />
            <span className="hidden sm:inline">Threads</span>
          </Link>
          <span className="mx-1 text-input">/</span>
          <span className="truncate text-xs text-muted-foreground">
            {thread.repo}
          </span>
          <span className="shrink-0 text-xs text-muted-foreground">
            #{thread.issueNumber}
          </span>
        </>
      }
    >
      <Tabs
        value={traceOpen ? "trace" : "chat"}
        onValueChange={(view) =>
          setParams(view === "trace" ? { view: "trace" } : {})
        }
        className="min-h-0 flex-1 gap-0"
      >
        <div
          data-thread-toolbar
          className="flex min-h-12 shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-4 py-2 md:px-6"
        >
          <div className="flex min-w-0 flex-1 basis-full items-center gap-2 sm:basis-auto">
            <h1 className="min-w-0 truncate text-sm font-medium tracking-tight">
              {title}
            </h1>
            <StatusPill status={thread.state} />
          </div>
          <TabsList
            aria-label="Thread views"
            className="h-8 shrink-0 bg-muted/60"
          >
            <TabsTrigger value="chat" className="gap-2 px-3 text-xs">
              <MessageSquare className="size-3.5" />
              Conversation
            </TabsTrigger>
            <TabsTrigger value="trace" className="gap-2 px-3 text-xs">
              <Workflow className="size-3.5" />
              Trace
            </TabsTrigger>
          </TabsList>
          <div className="ml-auto flex items-center gap-1.5 sm:ml-0">
            {thread.issueUrl && (
              <Button
                variant="ghost"
                size="sm"
                asChild
                className="hidden h-7 text-xs text-muted-foreground md:inline-flex"
              >
                <a href={thread.issueUrl} target="_blank" rel="noreferrer">
                  Issue
                  <ExternalLink className="size-3" />
                </a>
              </Button>
            )}
            {thread.prUrl && (
              <Button
                variant="outline"
                size="sm"
                asChild
                className="h-7 text-xs"
              >
                <a href={thread.prUrl} target="_blank" rel="noreferrer">
                  <GitPullRequest className="size-3.5" />
                  PR #{thread.prNumber}
                </a>
              </Button>
            )}
            {pendingEvents.length > 0 && (
              <Dialog>
                <DialogTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="gap-1.5 text-xs text-muted-foreground"
                  >
                    <ListOrdered className="size-3.5" />
                    {pendingEvents.length} queued
                  </Button>
                </DialogTrigger>
                <DialogContent className="rounded-2xl">
                  <DialogHeader>
                    <DialogTitle>Queued updates</DialogTitle>
                    <DialogDescription>
                      These updates become the next turn. Interject to ask the
                      current run to stop at its next boundary.
                    </DialogDescription>
                  </DialogHeader>
                  <div className="max-h-80 space-y-3 overflow-y-auto">
                    {pendingEvents.map((event) => (
                      <div
                        key={event.id}
                        className="rounded-lg border border-border p-3"
                      >
                        <p className="text-[11px] text-muted-foreground">
                          {event.kind.replace(/_/g, " ")}
                        </p>
                        <p className="mt-1 line-clamp-3 text-sm">
                          {eventPreview(event.kind, event.payload)}
                        </p>
                        <Button
                          variant="outline"
                          size="sm"
                          className="mt-3"
                          disabled={busy !== null}
                          onClick={() =>
                            void act(event.id, () => interjectEvent(event.id))
                          }
                        >
                          Interject
                        </Button>
                      </div>
                    ))}
                  </div>
                </DialogContent>
              </Dialog>
            )}
            {active && (
              <>
                <span className="hidden items-center gap-2 text-xs text-muted-foreground sm:flex">
                  <span className="size-1.5 animate-pulse rounded-full bg-success" />
                  {active.status === "queued"
                    ? "Queued"
                    : active.agent === "chat"
                      ? "Responding"
                      : "Working"}
                </span>
                <IconButton
                  label="Stop current run"
                  disabled={busy !== null}
                  onClick={() =>
                    void act(active.id, () => cancelRun(active.id))
                  }
                >
                  <Square className="size-3" />
                </IconButton>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Run options"
                    >
                      <MoreHorizontal />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem
                      disabled={busy !== null}
                      onSelect={() =>
                        void act(active.id, () => keepSandbox(active.id))
                      }
                    >
                      Keep sandbox for debugging
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </>
            )}
          </div>
        </div>
        {(error || loadError) && (
          <p
            role="alert"
            className="mx-5 mt-3 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive"
          >
            {error || loadError}
          </p>
        )}
        <TabsContent
          value="chat"
          transition={{ duration: 0.15 }}
          className="mt-0 flex min-h-0 flex-1 flex-col"
        >
          <Conversation
            detail={detail}
            live={live}
            landedEventId={landedEventId}
            onOpenRun={(runId) => setParams({ run: runId })}
          />
          {(showPhaseTrail || queuedChat.length > 0) && (
            <div className="mx-auto flex w-full max-w-[800px] items-center justify-between gap-3 px-5 pt-3 sm:px-8">
              {showPhaseTrail ? (
                <PhaseTrail
                  phases={phaseTrail!.phases!}
                  visited={phaseTrail!.visited ?? []}
                  current={phaseLive?.phase ?? phaseTrail!.phase ?? null}
                />
              ) : (
                <span aria-hidden />
              )}
              <QueuedChip
                messages={queuedChat.map((event) => ({
                  id: event.id,
                  body: payloadStr(event.payload, "body") ?? "(message)",
                  at: event.receivedAt,
                }))}
                interjectedId={interjectedId}
                interjecting={interjecting}
                onInterject={(eventId) => void interjectQueued(eventId)}
                onCancel={(eventId) => void cancelQueued(eventId)}
              />
            </div>
          )}
          <ChatComposer
            busy={!!active}
            disabled={TERMINAL.has(thread.state)}
            queuedEventId={queued?.id ?? null}
            onInterject={() => {
              if (queued) void interjectQueued(queued.id);
            }}
            onSend={async (text) => {
              await postMessage(id, text);
              await refetch();
            }}
          />
        </TabsContent>
        <TabsContent
          value="trace"
          transition={{ duration: 0.15 }}
          className="mt-0 flex min-h-0 flex-1 flex-col"
        >
          <Suspense
            fallback={
              <p className="p-6 text-sm text-muted-foreground">
                Loading trace explorer…
              </p>
            }
          >
            <TraceExplorer
              threadId={id}
              focusRunId={runParam}
              version={traceVersion}
            />
          </Suspense>
        </TabsContent>
      </Tabs>
    </AppShell>
  );
}
