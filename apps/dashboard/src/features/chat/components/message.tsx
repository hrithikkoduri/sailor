import { Check, CheckCheck, Layers2, Loader2, Workflow } from "lucide-react";
import { Markdown } from "@/elements/markdown";
import { Button } from "@/elements/button";
import { CopyButton } from "@/components/animate-ui/components/buttons/copy";
import { timeAgo } from "@/utils/format";
import { TurnContent } from "./turn-content";
import type { ConversationPart } from "../types";

export function HumanMessage({
  author,
  label,
  body,
  at,
}: {
  author: string;
  label: string;
  body: string;
  at: string;
}) {
  return (
    <article
      className="ml-auto max-w-[90%] sm:max-w-[80%]"
      aria-label={`Message from ${author}`}
    >
      <div className="mb-2 flex items-center justify-end gap-2 text-[11px] text-muted-foreground">
        <span>{label === "dashboard" ? "You" : author}</span>
        <span>·</span>
        <time dateTime={at}>{timeAgo(at)}</time>
      </div>
      <div className="rounded-2xl rounded-br-md bg-muted px-5 py-3.5">
        <Markdown text={body} className="text-[14px]" />
      </div>
    </article>
  );
}

export function AgentMessage({
  status,
  at,
  text,
  runId,
  onOpenRun,
  streaming = false,
  phase,
  tools = [],
  parts,
}: {
  status: string;
  disposition?: string | null;
  at?: string;
  text: string;
  runId?: string;
  onOpenRun?: (runId: string) => void;
  streaming?: boolean;
  phase?: string | null;
  tools?: Array<{ name: string; ok?: boolean }>;
  parts?: ConversationPart[];
}) {
  const copyText =
    parts
      ?.filter((part) => part.kind === "text" && part.text)
      .map((part) => part.text)
      .join("\n\n") || text;
  return (
    <article className="group flex gap-4" aria-label="Agent response">
      <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg border border-border bg-card">
        <Layers2 className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="mb-3 flex h-6 items-center gap-2 text-xs">
          <span className="font-semibold">Harness</span>
          <span className="text-[11px] text-muted-foreground">
            {streaming ? "Working on it" : at ? timeAgo(at) : ""}
          </span>
          {streaming && (
            <Loader2 className="size-3 animate-spin text-muted-foreground" />
          )}
        </div>
        {parts?.length ? (
          <TurnContent parts={parts} running={streaming} />
        ) : text ? (
          <div className="text-[14px]">
            <Markdown text={text} />
            {streaming && <span className="streaming-caret" />}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            Thinking
            <span className="streaming-caret" />
          </p>
        )}
        {streaming && tools.length > 0 && (
          <div className="mt-4 flex flex-wrap gap-2">
            {tools.map((tool, i) => (
              <span
                key={`${tool.name}-${i}`}
                className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground"
              >
                {tool.ok === undefined ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : (
                  <Check className="size-3" />
                )}
                <span className="font-mono text-[11px]">{tool.name}</span>
              </span>
            ))}
          </div>
        )}
        {!streaming && (
          <div className="mt-3 flex items-center gap-1 text-muted-foreground">
            <CopyButton
              content={copyText}
              variant="ghost"
              size="xs"
              aria-label="Copy response"
            />
            <span className="mx-1 h-3 w-px bg-border" />
            {runId && onOpenRun && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 gap-1.5 px-2 text-[11px] text-muted-foreground"
                onClick={() => onOpenRun(runId)}
              >
                <Workflow className="size-3" />
                View trace
              </Button>
            )}
            {status === "failed" && (
              <span className="ml-2 text-xs text-destructive">
                Stopped with an error
              </span>
            )}
          </div>
        )}
      </div>
    </article>
  );
}

export function SystemNote({
  text,
  count,
  at,
}: {
  text: string;
  count?: number;
  at: string;
}) {
  return (
    <div className="flex items-start gap-2 pl-12 text-[11px] leading-relaxed text-muted-foreground">
      <CheckCheck className="mt-0.5 size-3 shrink-0" />
      <span>
        {text}
        {count && count > 1 ? ` · ${count} updates` : ""}
      </span>
      <time className="ml-auto shrink-0" dateTime={at}>
        {timeAgo(at)}
      </time>
    </div>
  );
}
