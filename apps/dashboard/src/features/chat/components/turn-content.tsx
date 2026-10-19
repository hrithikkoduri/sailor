import { useEffect, useRef, useState } from "react";
import { Archive, Brain, Check, X } from "lucide-react";
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from "@/components/animate-ui/components/radix/accordion";
import { Helm } from "@/elements/brand";
import { Markdown } from "@/elements/markdown";
import { cn } from "@/utils/cn";
import type { ConversationPart } from "../types";
import { useDebugMode } from "@/features/debug/debug-provider";

type Block =
  | { kind: "part"; part: ConversationPart }
  | {
      kind: "activity";
      id: string;
      calls: ConversationPart[];
      active: boolean;
    };

/** Text → activity → text survives both live updates and a page refresh. */
export function TurnContent({
  parts,
  running,
}: {
  parts: ConversationPart[];
  running: boolean;
}) {
  const blocks: Block[] = [];
  for (const part of parts) {
    // Older traces (and older servers) created a reasoning part for
    // `reasoning_tokens: 0` with no text — it is noise, not a block.
    if (
      part.kind === "reasoning" &&
      part.complete &&
      !part.text?.trim() &&
      !((part.reasoningTokens ?? 0) > 0)
    )
      continue;
    if (
      part.kind === "text" &&
      !part.text &&
      parts.some(
        (other) => other.kind === "reasoning" && other.step === part.step,
      )
    )
      continue;
    if (part.kind === "tool") {
      const last = blocks.at(-1);
      if (last?.kind === "activity") last.calls.push(part);
      else
        blocks.push({
          kind: "activity",
          id: part.id,
          calls: [part],
          active: false,
        });
    } else if (
      part.kind === "reasoning" ||
      part.kind === "compaction" ||
      part.text ||
      (!part.complete && running)
    )
      blocks.push({ kind: "part", part });
  }
  const last = blocks.at(-1);
  if (last?.kind === "activity") last.active = running;
  return (
    <div className="space-y-4">
      {blocks.map((block) =>
        block.kind === "activity" ? (
          <Activity key={block.id} calls={block.calls} active={block.active} />
        ) : block.part.kind === "reasoning" ? (
          <Reasoning key={block.part.id} part={block.part} />
        ) : block.part.kind === "compaction" ? (
          <Compaction key={block.part.id} part={block.part} />
        ) : (
          <div key={block.part.id}>
            {block.part.text ? (
              <Markdown text={block.part.text} />
            ) : (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <Helm size={16} className="helm-spin" />
                Thinking
                <span className="streaming-caret" />
              </p>
            )}
            {block.part.text && !block.part.complete && running && (
              <span className="streaming-caret" />
            )}
          </div>
        ),
      )}
    </div>
  );
}

/**
 * One quiet disclosure line; expand for action verbs and outcomes only.
 * Inputs and outputs stay in Trace. The live list opens while working and
 * collapses when the next assistant step begins.
 */
function Activity({
  calls,
  active,
}: {
  calls: ConversationPart[];
  active: boolean;
}) {
  const { enabled: debug } = useDebugMode();
  const [open, setOpen] = useState(active || debug);
  useEffect(() => {
    setOpen(active || debug);
  }, [active, debug]);
  const failures = calls.filter((call) => call.ok === false).length;
  const pending = calls.filter((call) => !call.complete).length;
  const busy = active && pending > 0;
  return (
    <Accordion
      type="single"
      collapsible
      value={open ? "activity" : ""}
      onValueChange={(value) => setOpen(!!value)}
    >
      <AccordionItem value="activity" className="border-0">
        <AccordionTrigger className="min-h-8 flex-none items-center justify-start gap-2 py-1.5 text-xs font-normal text-muted-foreground hover:text-foreground hover:no-underline [&>svg:last-child]:size-3 [&>svg:last-child]:translate-y-0">
          <span className="flex min-w-0 items-center gap-2">
            <Helm size={16} className={cn("shrink-0", busy && "helm-spin")} />
            <span>
              {calls.length} action{calls.length === 1 ? "" : "s"}{" "}
              {busy ? "in progress" : "performed"}
              {failures > 0 && ` · ${failures} failed`}
            </span>
          </span>
        </AccordionTrigger>
        <AccordionContent className="pt-1 pb-1">
          <ul
            aria-label="Actions performed"
            className="ml-2 space-y-3 border-l border-border py-1 pl-5"
          >
            {calls.map((call) => {
              const working = active && !call.complete;
              if (debug)
                return (
                  <DebugAction key={call.id} call={call} working={working} />
                );
              return (
                <li
                  key={call.id}
                  className="flex items-start gap-2 text-xs text-muted-foreground"
                >
                  <ActionIdentity call={call} working={working} />
                </li>
              );
            })}
          </ul>
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  );
}

function ActionIdentity({
  call,
  working,
}: {
  call: ConversationPart;
  working: boolean;
}) {
  const failed = call.ok === false;
  return (
    <>
      {working ? (
        <Helm size={16} className="helm-spin shrink-0" />
      ) : failed ? (
        <X aria-hidden className="size-4 shrink-0 text-destructive" />
      ) : call.ok === true ? (
        <Check aria-hidden className="size-4 shrink-0" />
      ) : (
        <Helm size={16} className="shrink-0" />
      )}
      <span className={cn("min-w-0 break-words", failed && "text-destructive")}>
        {call.verb ?? call.name}
      </span>
      <span
        className={cn(
          "ml-auto shrink-0 text-[11px]",
          failed && "text-destructive",
        )}
      >
        {working
          ? "Running"
          : failed
            ? "Failed"
            : call.ok === true
              ? "Completed"
              : "Recorded"}
      </span>
    </>
  );
}

/** Debug mode reveals only the already-authorized conversation projection;
 * it neither changes the agent nor requests extra hidden server data. */
function DebugAction({
  call,
  working,
}: {
  call: ConversationPart;
  working: boolean;
}) {
  const name = call.name ?? "tool";
  const failed = call.ok === false;
  return (
    <li
      data-tool-status={failed ? "failed" : working ? "running" : "completed"}
    >
      <Accordion
        type="single"
        collapsible
        defaultValue="details"
        className={cn(
          "min-w-0 rounded-lg border border-border bg-card px-3",
          failed && "border-destructive/35",
        )}
      >
        <AccordionItem value="details" className="border-0">
          <AccordionTrigger
            aria-label={`${name} details${failed ? " — failed" : ""}`}
            className="items-center gap-2 py-3 text-xs font-normal text-muted-foreground hover:no-underline"
          >
            <span className="flex min-w-0 flex-1 items-start gap-2">
              <ActionIdentity call={call} working={working} />
            </span>
          </AccordionTrigger>
          <AccordionContent className="space-y-3 pb-3">
            <section aria-label={`Input for ${name}`}>
              <p className="mb-1.5 text-[11px] font-medium text-muted-foreground">
                Input · {name}
              </p>
              <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/40 p-3 font-mono text-[11px] leading-relaxed">
                {JSON.stringify(call.input ?? {}, null, 2)}
              </pre>
            </section>
            <section aria-label={`Output for ${name}`}>
              <p
                className={cn(
                  "mb-1.5 text-[11px] font-medium text-muted-foreground",
                  failed && "text-destructive",
                )}
              >
                {failed ? "Output · Failed" : "Output"}
              </p>
              <pre
                className={cn(
                  "max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/40 p-3 font-mono text-[11px] leading-relaxed",
                  failed && "bg-destructive/2 text-destructive",
                )}
              >
                {call.content ||
                  (working ? "Waiting for output…" : "No output recorded.")}
              </pre>
              {(call.content?.length ?? 0) >= 4000 && (
                <p className="mt-1.5 text-[11px] text-muted-foreground">
                  Output preview may be truncated.
                </p>
              )}
            </section>
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    </li>
  );
}

function Reasoning({ part }: { part: ConversationPart }) {
  const [open, setOpen] = useState(!part.complete);
  const body = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  useEffect(() => {
    if (part.complete) setOpen(false);
  }, [part.complete]);
  // While the provider is still thinking, the open block tails its text —
  // unless the reader scrolled up to study an earlier passage.
  useEffect(() => {
    const el = body.current;
    if (!el || !open || part.complete) return;
    if (following.current) el.scrollTop = el.scrollHeight;
  }, [part.text, open, part.complete]);
  return (
    <Accordion
      type="single"
      collapsible
      value={open ? "reasoning" : ""}
      onValueChange={(value) => setOpen(!!value)}
    >
      <AccordionItem value="reasoning" className="border-0">
        <AccordionTrigger className="items-center py-1.5 text-xs font-normal text-muted-foreground hover:no-underline">
          <span className="flex items-center gap-2">
            {part.complete ? (
              <Brain className="size-3.5" />
            ) : (
              <Helm size={16} className="helm-spin" />
            )}
            {part.complete ? "Provider reasoning" : "Thinking"}
            {part.reasoningTokens !== undefined && (
              <span>
                · {part.reasoningTokens.toLocaleString()} reasoning tokens
              </span>
            )}
          </span>
        </AccordionTrigger>
        <AccordionContent className="pt-2 text-xs text-muted-foreground">
          <div
            ref={body}
            onScroll={() => {
              const el = body.current;
              if (!el) return;
              following.current =
                el.scrollHeight - el.scrollTop - el.clientHeight < 40;
            }}
            className="max-h-64 overflow-y-auto border-l border-border pl-3"
          >
            {part.text ? (
              <Markdown
                text={part.text}
                className="text-xs text-muted-foreground"
              />
            ) : (
              "The provider reported reasoning-token usage, but did not return reasoning text."
            )}
          </div>
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  );
}

/** A visible handoff, not a hidden rewrite: one quiet line; expand for the
 * summary the agent now carries. Debug mode reveals the folded transcript. */
function Compaction({ part }: { part: ConversationPart }) {
  const { enabled: debug } = useDebugMode();
  const [open, setOpen] = useState(false);
  return (
    <Accordion
      type="single"
      collapsible
      value={open ? "compaction" : ""}
      onValueChange={(value) => setOpen(!!value)}
    >
      <AccordionItem value="compaction" className="border-0">
        <AccordionTrigger className="items-center py-1.5 text-xs font-normal text-muted-foreground hover:no-underline">
          <span className="flex items-center gap-2">
            <Archive className="size-3.5" />
            Context compacted
            {part.removedMessages !== undefined && (
              <span>
                · {part.removedMessages} message
                {part.removedMessages === 1 ? "" : "s"} folded
                {part.keptMessages !== undefined &&
                  `, ${part.keptMessages} kept`}
              </span>
            )}
          </span>
        </AccordionTrigger>
        <AccordionContent className="pt-2 text-xs text-muted-foreground">
          <div className="max-h-64 overflow-y-auto border-l border-border pl-3">
            <p className="mb-1.5 text-[11px] font-medium">
              Summary carried forward
            </p>
            {part.summary ? (
              <Markdown
                text={part.summary}
                className="text-xs text-muted-foreground"
              />
            ) : (
              "The conversation was folded, but no summary text was recorded."
            )}
          </div>
          {debug && part.folding && (
            <section aria-label="Folded transcript" className="mt-3">
              <p className="mb-1.5 text-[11px] font-medium">
                Folded transcript · debug
              </p>
              <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/40 p-3 font-mono text-[11px] leading-relaxed">
                {part.folding}
              </pre>
            </section>
          )}
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  );
}
