import { useState } from "react";
import { CheckCheck, Workflow } from "lucide-react";
import { Helm } from "@/elements/brand";
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
    <article aria-label={`Message from ${author}`}>
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
  text,
  runId,
  onOpenRun,
  streaming = false,
  parts,
}: {
  status: string;
  text: string;
  runId?: string;
  onOpenRun?: (runId: string) => void;
  streaming?: boolean;
  parts?: ConversationPart[];
}) {
  const copyText =
    parts
      ?.filter((part) => part.kind === "text" && part.text)
      .map((part) => part.text)
      .join("\n\n") || text;
  return (
    <article
      className="group min-w-0"
      aria-label="Agent response"
      aria-busy={streaming}
    >
      {parts?.length ? (
        <TurnContent parts={parts} running={streaming} />
      ) : text ? (
        <div className="text-[14px]">
          <Markdown text={text} />
          {streaming && <span className="streaming-caret" />}
        </div>
      ) : (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          {streaming && <Helm size={16} className="helm-spin" />}
          Thinking
          <span className="streaming-caret" />
        </p>
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
    </article>
  );
}

export function SystemNote({
  text,
  count,
  at,
  details,
  snippet,
  hidden,
}: {
  text: string;
  count?: number;
  at: string;
  /** Expandable body (review/comment text). */
  details?: string;
  /** Expandable diff excerpt (review comments). */
  snippet?: string;
  /** Debug-only entry — tagged so it is clear why it is here. */
  hidden?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const expandable = Boolean(details || snippet);
  const label = `${text}${count && count > 1 ? ` · ${count} updates` : ""}`;
  return (
    <div className="text-[11px] leading-relaxed text-muted-foreground">
      <div className="flex items-start gap-2">
        <CheckCheck className="mt-0.5 size-3 shrink-0" />
        {expandable ? (
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
            className="min-w-0 text-left transition-colors hover:text-foreground"
          >
            <span className="underline decoration-border underline-offset-2">
              {label}
            </span>
            {hidden && (
              <span className="ml-1.5 rounded bg-muted px-1 py-px align-middle text-[9px] tracking-wide uppercase">
                hidden
              </span>
            )}
          </button>
        ) : (
          <span>
            {label}
            {hidden && (
              <span className="ml-1.5 rounded bg-muted px-1 py-px align-middle text-[9px] tracking-wide uppercase">
                hidden
              </span>
            )}
          </span>
        )}
        <time className="ml-auto shrink-0" dateTime={at}>
          {timeAgo(at)}
        </time>
      </div>
      {open && expandable && (
        <div className="mt-2 ml-5 space-y-2 rounded-lg border border-border bg-card/50 p-2.5">
          {snippet && (
            <pre className="overflow-x-auto font-mono text-[10.5px] leading-relaxed whitespace-pre-wrap">
              {snippet}
            </pre>
          )}
          {details && <Markdown text={details} className="text-[12px]" />}
        </div>
      )}
    </div>
  );
}
