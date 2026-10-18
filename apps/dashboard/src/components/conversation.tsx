/**
 * Conversation — the thread as a chat, not a log.
 *
 * The operator speaks on the right (bubbles), the agent answers on the left
 * (markdown, no box), system events collapse into quiet centered lines, and
 * consecutive push notes merge into one count. While a run works, its reply
 * streams into a live bubble with a caret and tool chips.
 */
import { useEffect, useMemo, useRef } from "react";
import { Bot, GitPullRequest } from "lucide-react";
import type { LiveEvent, ThreadDetail, ThreadEventRow, ThreadRun } from "@/api";
import { Markdown } from "@/components/markdown";
import { StatusPill } from "@/components/status";
import { shortId, timeAgo } from "@/lib/format";
import { cn } from "@/lib/utils";

export interface LiveState {
  runId: string;
  phase: string | null;
  text: string;
  tools: Array<{ name: string; ok?: boolean }>;
  startedAt: number;
}

export function applyLiveEvent(prev: LiveState | null, event: LiveEvent): LiveState | null {
  switch (event.kind) {
    case "llm_started":
      return {
        runId: event.runId,
        phase: event.phase ?? prev?.phase ?? null,
        text: "",
        tools: prev?.runId === event.runId ? prev.tools : [],
        startedAt: prev?.startedAt ?? Date.now(),
      };
    case "delta":
      if (!prev || prev.runId !== event.runId) return prev;
      return { ...prev, text: event.text ?? "" };
    case "assistant_done":
      if (!prev || prev.runId !== event.runId) return prev;
      return { ...prev, text: event.text ?? prev.text };
    case "phase":
      if (!prev || prev.runId !== event.runId) return prev;
      return { ...prev, phase: event.phase ?? prev.phase };
    case "tool_call":
      if (!prev || prev.runId !== event.runId) return prev;
      return { ...prev, tools: [...prev.tools, { name: event.name ?? "tool" }].slice(-6) };
    case "tool_result":
      if (!prev || prev.runId !== event.runId) return prev;
      return {
        ...prev,
        tools: prev.tools.map((t, i) =>
          i === prev.tools.length - 1 && t.ok === undefined ? { ...t, ok: event.ok } : t,
        ),
      };
    default:
      return prev;
  }
}

type FeedItem =
  | { kind: "human"; id: string; at: string; author: string; body: string; label: string }
  | { kind: "agent"; id: string; at: string; run: ThreadRun }
  | { kind: "note"; id: string; at: string; text: string; count?: number };

function eventToFeedItem(e: ThreadEventRow): FeedItem | null {
  const p = e.payload as Record<string, unknown>;
  const str = (k: string) => (typeof p[k] === "string" ? (p[k] as string) : undefined);
  const at = e.receivedAt;
  switch (e.kind) {
    case "chat_message":
      return { kind: "human", id: `e${e.id}`, at, author: str("author") ?? "you", body: str("body") ?? "", label: "dashboard" };
    case "issue_comment":
      return { kind: "human", id: `e${e.id}`, at, author: str("author") ?? "someone", body: str("body") ?? "", label: "comment" };
    case "pull_request_review":
    case "pull_request_review_comment":
      return {
        kind: "human",
        id: `e${e.id}`,
        at,
        author: str("author") ?? "reviewer",
        body: str("body") || "(see the diff comments)",
        label: "review",
      };
    case "issue_labeled":
      return { kind: "note", id: `e${e.id}`, at, text: `labeled agent:fix${str("title") ? ` · ${str("title")}` : ""}` };
    case "check_run":
    case "status":
      return {
        kind: "note",
        id: `e${e.id}`,
        at,
        text: `CI: ${(Array.isArray(p.checks) ? (p.checks as string[]).join(", ") : undefined) ?? "a check"} failed`,
      };
    case "push": {
      const commits = typeof p.commits === "number" ? p.commits : undefined;
      return { kind: "note", id: `e${e.id}`, at, text: `agent pushed${commits ? ` ${commits} commit${commits === 1 ? "" : "s"}` : ""} to ${str("ref") ?? "the branch"}` };
    }
    case "pr_conflict":
      return { kind: "note", id: `e${e.id}`, at, text: `PR branch conflicts with ${str("base") ?? "base"}` };
    default:
      return { kind: "note", id: `e${e.id}`, at, text: e.kind.replace(/_/g, " ") };
  }
}

export function Conversation({
  detail,
  live,
  onOpenRun,
}: {
  detail: ThreadDetail;
  live: LiveState | null;
  onOpenRun: (runId: string) => void;
}) {
  const items = useMemo(() => {
    const feed: FeedItem[] = [];
    for (const e of detail.events) {
      const item = eventToFeedItem(e);
      if (item) feed.push(item);
    }
    for (const run of detail.runs) {
      if (run.agentText) {
        feed.push({ kind: "agent", id: `r${run.id}`, at: run.finishedAt ?? run.startedAt ?? run.createdAt, run });
      } else if (run.status === "failed" && run.error) {
        feed.push({ kind: "note", id: `r${run.id}`, at: run.finishedAt ?? run.createdAt, text: `a run failed · ${run.error.slice(0, 90)}` });
      }
    }
    feed.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());

    // Merge consecutive pushes (the runaway-loop cleanup left noisy trails).
    const merged: FeedItem[] = [];
    for (const item of feed) {
      const last = merged[merged.length - 1];
      if (
        item.kind === "note" &&
        last?.kind === "note" &&
        item.text.startsWith("agent pushed") &&
        last.text.startsWith("agent pushed")
      ) {
        last.count = (last.count ?? 1) + 1;
        continue;
      }
      merged.push(item);
    }
    return merged;
  }, [detail]);

  const activeRun = detail.runs.find((r) => r.status === "running" || r.status === "queued");
  const streaming = live && activeRun && live.runId === activeRun.id;
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [items.length, live?.text, streaming]);

  if (items.length === 0 && !streaming) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
        <div className="font-mono text-sm text-muted-foreground">
          <span className="text-primary">&gt;</span> waiting for the first turn
          <span className="streaming-caret" />
        </div>
        <p className="max-w-sm text-xs text-muted-foreground/80">
          Label the issue <span className="rounded bg-muted px-1.5 py-0.5 font-mono">agent:fix</span> on GitHub — or just
          write a message below.
        </p>
      </div>
    );
  }

  return (
    <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-5 py-7">
        {items.map((item) => {
          if (item.kind === "note") {
            return (
              <div key={item.id} className="flex items-center justify-center gap-2 font-mono text-[10.5px] text-muted-foreground/70">
                <span className="h-px w-8 bg-border/60" />
                <span>
                  {item.text}
                  {item.count !== undefined && item.count > 1 && (
                    <span className="text-muted-foreground/50"> ×{item.count}</span>
                  )}{" "}
                  · {timeAgo(item.at)}
                </span>
                <span className="h-px w-8 bg-border/60" />
              </div>
            );
          }

          if (item.kind === "human") {
            return (
              <div key={item.id} className="flex justify-end">
                <div className="max-w-[85%]">
                  <div className="mb-1 flex items-center justify-end gap-2 font-mono text-[10.5px] text-muted-foreground">
                    <span className="text-slate-300">{item.author}</span>
                    <span className="rounded bg-muted/60 px-1.5 py-px text-[10px]">{item.label}</span>
                    <span>{timeAgo(item.at)}</span>
                  </div>
                  <div className="rounded-2xl rounded-br-md border border-border/60 bg-muted/25 px-4 py-2.5">
                    <Markdown text={item.body} className="text-[13.5px]" />
                  </div>
                </div>
              </div>
            );
          }

          // agent turn — plain text on the background, like someone talking
          return (
            <div key={item.id} className="flex gap-3.5">
              <span className="mt-6 flex size-7 shrink-0 items-center justify-center rounded-lg border border-primary/25 bg-primary/10">
                <Bot className="size-3.5 text-primary" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="mb-1.5 flex items-center gap-2 font-mono text-[10.5px] text-muted-foreground">
                  <span className="text-slate-300">harness</span>
                  <StatusPill status={item.run.status} />
                  {item.run.disposition && <span>{item.run.disposition}</span>}
                  <span>{timeAgo(item.at)}</span>
                  <button
                    onClick={() => onOpenRun(item.run.id)}
                    className="ml-auto cursor-pointer underline decoration-dotted transition-colors hover:text-primary"
                  >
                    trace {shortId(item.run.id)}
                  </button>
                </div>
                <Markdown text={item.run.agentText ?? ""} className="text-[13.5px]" />
              </div>
            </div>
          );
        })}

        {streaming && (
          <div className="flex gap-3.5">
            <span className="mt-6 flex size-7 shrink-0 items-center justify-center rounded-lg border border-primary/25 bg-primary/10">
              <Bot className="size-3.5 animate-pulse text-primary" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="mb-1.5 flex items-center gap-2 font-mono text-[10.5px] text-muted-foreground">
                <span className="text-slate-300">harness</span>
                <StatusPill status="running" />
                {live.phase && <span className="text-primary/80">{live.phase}</span>}
              </div>
              {live.text ? (
                <>
                  <Markdown text={live.text} className="text-[13.5px]" />
                  <span className="streaming-caret" />
                </>
              ) : (
                <div className="font-mono text-xs text-muted-foreground">
                  thinking<span className="streaming-caret" />
                </div>
              )}
              {live.tools.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {live.tools.map((tool, i) => (
                    <span
                      key={`${tool.name}-${i}`}
                      className={cn(
                        "inline-flex items-center gap-1 rounded-md border border-border/70 bg-muted/25 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground",
                        tool.ok === false && "border-destructive/40 text-red-300/90",
                      )}
                    >
                      {tool.name}
                      {tool.ok === false && " ✗"}
                      {tool.ok === true && " ✓"}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
