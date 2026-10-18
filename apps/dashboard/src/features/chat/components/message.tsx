/** Message primitives for the conversation feed. */
import { Bot } from "lucide-react";
import { Markdown } from "@/elements/markdown";
import { StatusPill } from "@/elements/status-pill";
import { shortId, timeAgo } from "@/utils/format";
import { cn } from "@/utils/cn";

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
    <div className="flex justify-end">
      <div className="max-w-[85%]">
        <div className="mb-1 flex items-center justify-end gap-2 font-mono text-[10.5px] text-muted-foreground">
          <span className="text-slate-300">{author}</span>
          <span className="rounded bg-muted/60 px-1.5 py-px text-[10px]">{label}</span>
          <span>{timeAgo(at)}</span>
        </div>
        <div className="rounded-2xl rounded-br-md border border-border/60 bg-muted/25 px-4 py-2.5">
          <Markdown text={body} className="text-[13.5px]" />
        </div>
      </div>
    </div>
  );
}

/**
 * One agent turn: avatar + meta line + markdown. The same component renders
 * the live streaming bubble (`streaming` + phase + in-flight tool chips).
 */
export function AgentMessage({
  status,
  disposition,
  at,
  text,
  runId,
  onOpenRun,
  streaming = false,
  phase,
  tools = [],
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
}) {
  return (
    <div className="flex gap-3.5">
      <span className="mt-6 flex size-7 shrink-0 items-center justify-center rounded-lg border border-primary/25 bg-primary/10">
        <Bot className={cn("size-3.5 text-primary", streaming && "animate-pulse")} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="mb-1.5 flex items-center gap-2 font-mono text-[10.5px] text-muted-foreground">
          <span className="text-slate-300">harness</span>
          <StatusPill status={status} />
          {disposition && <span>{disposition}</span>}
          {streaming && phase && <span className="text-primary/80">{phase}</span>}
          {at && <span>{timeAgo(at)}</span>}
          {!streaming && runId && onOpenRun && (
            <button
              onClick={() => onOpenRun(runId)}
              className="ml-auto cursor-pointer underline decoration-dotted transition-colors hover:text-primary"
            >
              trace {shortId(runId)}
            </button>
          )}
        </div>
        {text ? (
          <>
            <Markdown text={text} className="text-[13.5px]" />
            {streaming && <span className="streaming-caret" />}
          </>
        ) : (
          <div className="font-mono text-xs text-muted-foreground">
            thinking<span className="streaming-caret" />
          </div>
        )}
        {streaming && tools.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {tools.map((tool, i) => (
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
  );
}

/** Quiet centered system line (labels, CI, pushes). */
export function SystemNote({ text, count, at }: { text: string; count?: number; at: string }) {
  return (
    <div className="flex items-center justify-center gap-2 font-mono text-[10.5px] text-muted-foreground/70">
      <span className="h-px w-8 bg-border/60" />
      <span>
        {text}
        {count !== undefined && count > 1 && <span className="text-muted-foreground/50"> ×{count}</span>} · {timeAgo(at)}
      </span>
      <span className="h-px w-8 bg-border/60" />
    </div>
  );
}
