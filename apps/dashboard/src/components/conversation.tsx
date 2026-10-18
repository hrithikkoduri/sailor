/**
 * Conversation — the thread's story as a chat feed.
 *
 * Humans on one rail (GitHub comments, reviews, dashboard messages), the
 * agent on the other (its final text per run, markdown), system notes in
 * between (labels, CI, pushes) — plus the LIVE bubble: assistant text
 * streaming in as the run happens, with the current phase/tool activity.
 */
import { useEffect, useMemo, useRef } from "react";
import {
  Bot,
  Check,
  CircleAlert,
  GitBranch,
  GitCommitHorizontal,
  GitPullRequest,
  Tag,
  X,
} from "lucide-react";
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
      return { runId: event.runId, phase: event.phase ?? prev?.phase ?? null, text: "", tools: prev?.runId === event.runId ? prev.tools : [], startedAt: prev?.startedAt ?? Date.now() };
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
        tools: prev.tools.map((t, i) => (i === prev.tools.length - 1 && t.ok === undefined ? { ...t, ok: event.ok } : t)),
      };
    case "run_finished":
      return prev;
    default:
      return prev;
  }
}

type FeedItem =
  | { kind: "human"; id: string; at: string; author: string; body: string; label: string }
  | { kind: "agent"; id: string; at: string; run: ThreadRun }
  | { kind: "note"; id: string; at: string; icon: "tag" | "pr" | "branch" | "check" | "error" | "commit"; text: string };

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
      return { kind: "human", id: `e${e.id}`, at, author: str("author") ?? "reviewer", body: str("body") ?? "(diff comment)", label: "review" };
    case "issue_labeled":
      return { kind: "note", id: `e${e.id}`, at, icon: "tag", text: `labeled agent:fix${str("title") ? ` — ${str("title")}` : ""}` };
    case "check_run":
    case "status":
      return { kind: "note", id: `e${e.id}`, at, icon: "check", text: `CI reported: ${(Array.isArray(p.checks) ? (p.checks as string[]).join(", ") : undefined) ?? "a check"} failed` };
    case "push":
      return { kind: "note", id: `e${e.id}`, at, icon: "branch", text: `the agent pushed${typeof p.commits === "number" ? ` ${p.commits} commit${p.commits === 1 ? "" : "s"}` : ""} to ${str("ref") ?? "the branch"}` };
    case "pr_conflict":
      return { kind: "note", id: `e${e.id}`, at, icon: "error", text: `the PR branch conflicts with ${str("base") ?? "the base branch"}` };
    case "issue_closed":
      return { kind: "note", id: `e${e.id}`, at, icon: "pr", text: "issue closed" };
    default:
      return { kind: "note", id: `e${e.id}`, at, icon: "commit", text: `${e.kind.replace(/_/g, " ")}` };
  }
}

const NOTE_ICONS = {
  tag: Tag,
  pr: GitPullRequest,
  branch: GitBranch,
  check: Check,
  error: CircleAlert,
  commit: GitCommitHorizontal,
} as const;

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
        feed.push({ kind: "note", id: `r${run.id}`, at: run.finishedAt ?? run.createdAt, icon: "error", text: `a run failed: ${run.error.slice(0, 120)}` });
      }
    }
    return feed.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
  }, [detail]);

  const activeRun = detail.runs.find((r) => r.status === "running" || r.status === "queued");
  const streaming = live && activeRun && live.runId === activeRun.id;
  const scroller = useRef<HTMLDivElement>(null);

  // Follow the stream while it writes (and jump on first render).
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
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-6">
        {items.map((item) => {
          if (item.kind === "note") {
            const Icon = NOTE_ICONS[item.icon] ?? GitCommitHorizontal;
            return (
              <div key={item.id} className="flex items-center gap-2 pl-1 font-mono text-[11px] text-muted-foreground">
                <Icon className="size-3.5 shrink-0 text-muted-foreground/70" />
                <span className="truncate">{item.text}</span>
                <span className="text-muted-foreground/50">· {timeAgo(item.at)}</span>
              </div>
            );
          }
          if (item.kind === "human") {
            return (
              <div key={item.id} className="flex gap-3">
                <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg border border-border bg-muted font-mono text-[11px] font-semibold uppercase text-muted-foreground">
                  {item.author.slice(0, 1)}
                </span>
                <div className="min-w-0 flex-1 rounded-xl border border-border/80 bg-card/50 px-4 py-3">
                  <div className="mb-1.5 flex items-center gap-2 text-[11px] text-muted-foreground">
                    <span className="font-medium text-slate-300">{item.author}</span>
                    <span className="rounded bg-muted/70 px-1.5 py-px font-mono text-[10px]">{item.label}</span>
                    <span>{timeAgo(item.at)}</span>
                  </div>
                  <Markdown text={item.body} className="text-[13.5px]" />
                </div>
              </div>
            );
          }
          // agent turn
          return (
            <div key={item.id} className="flex gap-3">
              <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg border border-primary/30 bg-primary/12">
                <Bot className="size-4 text-primary" />
              </span>
              <div className="min-w-0 flex-1 rounded-xl border border-border/60 bg-card/30 px-4 py-3">
                <div className="mb-1.5 flex items-center gap-2 text-[11px] text-muted-foreground">
                  <span className="font-medium text-slate-300">harness</span>
                  <StatusPill status={item.run.status} />
                  {item.run.disposition && <span className="font-mono text-[10px]">{item.run.disposition}</span>}
                  <span>{timeAgo(item.at)}</span>
                  <button
                    onClick={() => onOpenRun(item.run.id)}
                    className="ml-auto cursor-pointer font-mono text-[10.5px] text-muted-foreground underline decoration-dotted transition-colors hover:text-primary"
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
          <div className="flex gap-3">
            <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg border border-primary/30 bg-primary/12">
              <Bot className="size-4 animate-pulse text-primary" />
            </span>
            <div className="min-w-0 flex-1 rounded-xl border border-primary/25 bg-card/30 px-4 py-3">
              <div className="mb-1.5 flex items-center gap-2 text-[11px] text-muted-foreground">
                <span className="font-medium text-slate-300">harness</span>
                <StatusPill status="running" />
                {live.phase && <span className="font-mono text-[10px] text-primary/80">{live.phase}</span>}
              </div>
              {live.text ? (
                <Markdown text={live.text} className="text-[13.5px]" />
              ) : (
                <div className="font-mono text-xs text-muted-foreground">
                  thinking<span className="streaming-caret" />
                </div>
              )}
              {live.text && <span className="streaming-caret" />}
              {live.tools.length > 0 && (
                <div className="mt-2.5 flex flex-wrap gap-1.5">
                  {live.tools.map((tool, i) => (
                    <span
                      key={`${tool.name}-${i}`}
                      className={cn(
                        "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 font-mono text-[10px]",
                        tool.ok === undefined
                          ? "border-border bg-muted/50 text-muted-foreground"
                          : tool.ok
                            ? "border-primary/30 bg-primary/10 text-primary"
                            : "border-destructive/40 bg-destructive/10 text-red-300",
                      )}
                    >
                      {tool.ok === true && <Check className="size-2.5" />}
                      {tool.ok === false && <X className="size-2.5" />}
                      {tool.name}
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
