/**
 * Conversation — the thread as a chat, not a log.
 *
 * Feed assembly: humans from `events`, agent turns from each run's final
 * text, system notes for label/CI/push (consecutive pushes merge). While a
 * run works, the live bubble streams in via `useThreadStream`.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, MessageSquare } from "lucide-react";
import { Button } from "@/elements/button";
import type { ThreadDetail } from "@/features/threads/api";
import {
  AgentMessage,
  HumanMessage,
  SystemNote,
} from "@/features/chat/components/message";
import { mergeConversation, type LiveState } from "@/features/chat/live";
import { useDebugMode } from "@/features/debug/debug-provider";
import { cn } from "@/utils/cn";
import { QuestionForm } from "./components/question-form";
import { useThreadTabs } from "@/features/thread-tabs/thread-tabs-provider";
import { buildFeed } from "@/features/chat/conversation-feed";

export function Conversation({
  detail,
  live,
  landedEventId,
  onOpenRun,
  onAnswered,
}: {
  detail: ThreadDetail;
  live: LiveState | null;
  /** A message just interjected — animate it as it lands in the thread. */
  landedEventId?: string | null;
  onOpenRun: (runId: string) => void;
  onAnswered?: () => void;
}) {
  const { enabled: debug } = useDebugMode();
  const { getPosition, savePosition } = useThreadTabs();
  const items = useMemo(() => buildFeed(detail, debug), [detail, debug]);
  // Messages that just landed (drained from the queue or interjected) rise
  // into place; the first render never animates a whole history.
  const seenHuman = useRef<Set<string> | null>(null);
  const [freshIds, setFreshIds] = useState<Set<string>>(new Set());
  useEffect(() => {
    const humanIds = items
      .filter((item) => item.kind === "human")
      .map((item) => item.id);
    if (seenHuman.current === null) {
      seenHuman.current = new Set(humanIds);
      return;
    }
    const fresh = humanIds.filter((id) => !seenHuman.current!.has(id));
    if (fresh.length === 0) return;
    for (const id of fresh) seenHuman.current.add(id);
    setFreshIds(new Set(fresh));
  }, [items]);
  const streaming = live && !live.finished;
  const scroller = useRef<HTMLDivElement>(null);
  const initialPosition = useRef(getPosition(detail.thread.id));
  const following = useRef(initialPosition.current?.following ?? true);
  const restored = useRef(false);
  const [showJump, setShowJump] = useState(false);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (!restored.current) {
      restored.current = true;
      if (initialPosition.current && !initialPosition.current.following) {
        el.scrollTop = initialPosition.current.top;
        setShowJump(true);
        return;
      }
    }
    if (following.current) el.scrollTop = el.scrollHeight;
  }, [items.length, live?.sequence, streaming, detail.questions]);

  useEffect(() => {
    if (!landedEventId) return;
    const node = scroller.current?.querySelector(
      `[data-message-id="e${landedEventId}"]`,
    );
    const reduce = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    node?.scrollIntoView({
      behavior: reduce ? "auto" : "smooth",
      block: "center",
    });
  }, [landedEventId]);

  if (items.length === 0 && !streaming) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
        <MessageSquare className="size-7 text-muted-foreground" />
        <h2 className="text-lg font-medium tracking-tight">
          A conversation about the work.
        </h2>
        <p className="max-w-sm text-xs text-muted-foreground/80">
          Start with a goal or a question below. Attach a repository whenever the work needs one.
        </p>
      </div>
    );
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scroller}
        role="region"
        aria-label="Conversation messages"
        onScroll={() => {
          const el = scroller.current;
          if (!el) return;
          following.current =
            el.scrollHeight - el.scrollTop - el.clientHeight < 100;
          savePosition(detail.thread.id, { top: el.scrollTop, following: following.current });
          setShowJump(!following.current);
        }}
        className="min-h-0 flex-1 overflow-y-auto"
      >
        <div className="mx-auto flex w-full max-w-[800px] flex-col gap-8 px-5 py-10 sm:px-8">
          {items.map((item) => {
            // Pending forms float above the composer (thread view) so they are
            // never buried in the transcript; answered ones stay as history.
            if (item.kind === "question")
              return item.request.status === "pending" ? null : (
                <QuestionForm key={item.id} request={item.request} paused={false} onAnswered={() => onAnswered?.()} />
              );
            if (item.kind === "note") {
              return (
                <SystemNote
                  key={item.id}
                  text={item.text}
                  count={item.count}
                  at={item.at}
                  details={item.details}
                  snippet={item.snippet}
                  hidden={item.hidden}
                />
              );
            }
            if (item.kind === "human") {
              const landed =
                (landedEventId != null && item.id === `e${landedEventId}`) ||
                freshIds.has(item.id);
              return (
                <div
                  key={item.id}
                  data-message-id={item.id}
                  className={cn(
                    "ml-auto max-w-[90%] min-w-0 sm:max-w-[80%]",
                    landed && "message-land motion-reduce:animate-none",
                  )}
                >
                  <HumanMessage
                    author={item.author}
                    label={item.label}
                    body={item.body}
                    at={item.at}
                  />
                </div>
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
          className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full bg-card shadow-sm"
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
