/**
 * Conversation — the thread as a chat, not a log.
 *
 * Feed assembly: humans from `events`, agent turns from each run's final
 * text, system notes for label/CI/push (consecutive pushes merge). While a
 * run works, the live bubble streams in via `useThreadStream`.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, MessageSquare } from "lucide-react";
import { Button } from "@/elements/button";
import type {
  ThreadDetail,
  ThreadEventRow,
  ThreadRun,
} from "@/features/threads/api";
import {
  AgentMessage,
  HumanMessage,
  SystemNote,
} from "@/features/chat/components/message";
import { mergeConversation, type LiveState } from "@/features/chat/live";
import { payloadNum, payloadStr } from "@/utils/events";

type FeedItem =
  | {
      kind: "human";
      id: string;
      at: string;
      author: string;
      body: string;
      label: string;
    }
  | { kind: "agent"; id: string; at: string; run: ThreadRun }
  | { kind: "note"; id: string; at: string; text: string; count?: number };

const str = payloadStr;

function eventToFeedItem(e: ThreadEventRow): FeedItem | null {
  const p = e.payload;
  const at = e.receivedAt;
  switch (e.kind) {
    case "chat_message":
      return {
        kind: "human",
        id: `e${e.id}`,
        at,
        author: str(p, "author") ?? "you",
        body: str(p, "body") ?? "",
        label: "dashboard",
      };
    case "issue_comment":
      return {
        kind: "human",
        id: `e${e.id}`,
        at,
        author: str(p, "author") ?? "someone",
        body: str(p, "body") ?? "",
        label: "comment",
      };
    case "pull_request_review":
    case "pull_request_review_comment":
      return {
        kind: "human",
        id: `e${e.id}`,
        at,
        author: str(p, "author") ?? "reviewer",
        body: str(p, "body") || "(see the diff comments)",
        label: "review",
      };
    case "issue_labeled":
      return {
        kind: "note",
        id: `e${e.id}`,
        at,
        text: `labeled agent:fix${str(p, "title") ? ` · ${str(p, "title")}` : ""}`,
      };
    case "check_run":
    case "status": {
      const checks = Array.isArray(p.checks)
        ? (p.checks as string[]).join(", ")
        : "a check";
      return { kind: "note", id: `e${e.id}`, at, text: `CI: ${checks} failed` };
    }
    case "push": {
      const commits = payloadNum(p, "commits");
      return {
        kind: "note",
        id: `e${e.id}`,
        at,
        text: `agent pushed${commits ? ` ${commits} commit${commits === 1 ? "" : "s"}` : ""} to ${str(p, "ref") ?? "the branch"}`,
      };
    }
    case "pr_conflict":
      return {
        kind: "note",
        id: `e${e.id}`,
        at,
        text: `PR branch conflicts with ${str(p, "base") ?? "base"}`,
      };
    default:
      return {
        kind: "note",
        id: `e${e.id}`,
        at,
        text: e.kind.replace(/_/g, " "),
      };
  }
}

function buildFeed(detail: ThreadDetail): FeedItem[] {
  const feed: FeedItem[] = [];
  for (const e of detail.events) {
    const item = eventToFeedItem(e);
    if (item) feed.push(item);
  }
  for (const run of detail.runs) {
    if (
      run.agentText ||
      run.conversation?.parts.length ||
      ["running", "queued"].includes(run.status)
    ) {
      feed.push({
        kind: "agent",
        id: `r${run.id}`,
        at: run.startedAt ?? run.createdAt,
        run,
      });
    } else if (run.status === "failed" && run.error) {
      feed.push({
        kind: "note",
        id: `r${run.id}`,
        at: run.finishedAt ?? run.createdAt,
        text: `a run failed · ${run.error.slice(0, 90)}`,
      });
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
  const items = useMemo(() => buildFeed(detail), [detail]);
  const streaming = live && !live.finished;
  const scroller = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const [showJump, setShowJump] = useState(false);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (following.current) el.scrollTop = el.scrollHeight;
  }, [items.length, live?.sequence, streaming]);

  if (items.length === 0 && !streaming) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
        <MessageSquare className="size-7 text-muted-foreground" />
        <h2 className="text-lg font-medium tracking-tight">
          A conversation about the work.
        </h2>
        <p className="max-w-sm text-xs text-muted-foreground/80">
          Label the issue{" "}
          <span className="rounded bg-muted px-1.5 py-0.5 font-mono">
            agent:fix
          </span>{" "}
          on GitHub — or just write a message below.
        </p>
      </div>
    );
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scroller}
        onScroll={() => {
          const el = scroller.current;
          if (!el) return;
          following.current =
            el.scrollHeight - el.scrollTop - el.clientHeight < 100;
          setShowJump(!following.current);
        }}
        className="min-h-0 flex-1 overflow-y-auto"
      >
        <div className="mx-auto flex w-full max-w-[800px] flex-col gap-8 px-5 py-10 sm:px-8">
          {items.map((item) => {
            if (item.kind === "note") {
              return (
                <SystemNote
                  key={item.id}
                  text={item.text}
                  count={item.count}
                  at={item.at}
                />
              );
            }
            if (item.kind === "human") {
              return (
                <HumanMessage
                  key={item.id}
                  author={item.author}
                  label={item.label}
                  body={item.body}
                  at={item.at}
                />
              );
            }
            const conversation = mergeConversation(
              item.run.conversation,
              live?.runId === item.run.id ? live : null,
            );
            return (
              <AgentMessage
                key={item.id}
                status={item.run.status}
                disposition={item.run.disposition}
                at={item.at}
                text={item.run.agentText ?? ""}
                runId={item.run.id}
                onOpenRun={onOpenRun}
                parts={conversation.parts}
                streaming={
                  ["running", "queued"].includes(item.run.status) &&
                  !conversation.finished
                }
              />
            );
          })}

          {live && !detail.runs.some((r) => r.id === live.runId) && (
            <AgentMessage
              status="running"
              streaming={!live.finished}
              phase={live.phase}
              text=""
              parts={mergeConversation(undefined, live).parts}
            />
          )}
        </div>
      </div>
      {showJump && (
        <Button
          variant="outline"
          size="sm"
          className="absolute right-6 bottom-4 rounded-full bg-card shadow-sm"
          onClick={() => {
            const el = scroller.current;
            if (el) {
              el.scrollTop = el.scrollHeight;
              following.current = true;
              setShowJump(false);
            }
          }}
        >
          <ArrowDown className="size-3" />
          Latest message
        </Button>
      )}
    </div>
  );
}
