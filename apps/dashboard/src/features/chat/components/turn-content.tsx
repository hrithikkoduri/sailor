import { useEffect, useState } from "react";
import { Brain, Check, Loader2, X } from "lucide-react";
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from "@/components/animate-ui/components/radix/accordion";
import { Markdown } from "@/elements/markdown";
import type { ConversationPart } from "../types";

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
          <ActivityGroup
            key={block.id}
            calls={block.calls}
            active={block.active}
          />
        ) : block.part.kind === "reasoning" ? (
          <Reasoning key={block.part.id} part={block.part} />
        ) : (
          <div key={block.part.id}>
            {block.part.text ? (
              <Markdown text={block.part.text} />
            ) : (
              <p className="text-sm text-muted-foreground">
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

function ActivityGroup({
  calls,
  active,
}: {
  calls: ConversationPart[];
  active: boolean;
}) {
  const [open, setOpen] = useState(active);
  useEffect(() => {
    setOpen(active);
  }, [active]);
  const failures = calls.filter((call) => call.ok === false).length;
  const current = calls.find((call) => !call.complete) ?? calls.at(-1)!;
  const outcome = failures
    ? `· ${failures} failed`
    : calls.every((call) => call.ok !== undefined)
      ? "completed"
      : "recorded";
  return (
    <Accordion
      type="single"
      collapsible
      value={open ? "activity" : ""}
      onValueChange={(value) => setOpen(!!value)}
      className="rounded-lg border border-border bg-card/60 px-3"
    >
      <AccordionItem value="activity" className="border-0">
        <AccordionTrigger className="items-center gap-2 py-2.5 text-xs font-normal text-muted-foreground hover:no-underline">
          <span className="flex min-w-0 items-center gap-2">
            {active ? (
              <Loader2 className="size-3.5 shrink-0 animate-spin" />
            ) : failures ? (
              <X className="size-3.5 text-destructive" />
            ) : (
              <Check className="size-3.5" />
            )}
            <span className="truncate">
              {active
                ? (current.verb ?? current.name)
                : `${calls.length} action${calls.length === 1 ? "" : "s"} ${outcome}`}
            </span>
          </span>
        </AccordionTrigger>
        <AccordionContent className="space-y-3 pb-3">
          {calls.map((call) => (
            <div
              key={call.id}
              className="rounded-md border border-border bg-background p-3"
            >
              <div className="flex items-center gap-2 text-xs">
                {!call.complete ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : call.ok === false ? (
                  <X className="size-3 text-destructive" />
                ) : (
                  <Check className="size-3 text-muted-foreground" />
                )}
                <span className="font-medium">{call.verb ?? call.name}</span>
                <span className="ml-auto text-[10px] text-muted-foreground">
                  {call.name}
                </span>
              </div>
              {call.input && Object.keys(call.input).length > 0 && (
                <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-muted-foreground">
                  {JSON.stringify(call.input, null, 2)}
                </pre>
              )}
              {call.content && (
                <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words border-t border-border pt-2 font-mono text-[11px] leading-relaxed">
                  {call.content}
                </pre>
              )}
            </div>
          ))}
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  );
}

function Reasoning({ part }: { part: ConversationPart }) {
  const [open, setOpen] = useState(!part.complete);
  useEffect(() => {
    if (part.complete) setOpen(false);
  }, [part.complete]);
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
              <Loader2 className="size-3.5 animate-spin" />
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
          <div className="max-h-64 overflow-y-auto border-l border-border pl-3">
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
