import { HoverCard } from "radix-ui";
import { Loader2, MessageSquare, X, Zap } from "lucide-react";
import { Button } from "@/elements/button";
import { timeAgo } from "@/utils/format";

export interface QueuedMessage {
  id: string;
  body: string;
  at: string;
}

/**
 * The queued dashboard message(s), sitting on the phase row. Hover (or focus)
 * reveals every message in the batch — they are combined into one next turn —
 * with a per-message withdraw; the small Interject button stops the current
 * run so the batch lands next.
 */
export function QueuedChip({
  messages,
  interjectedId,
  interjecting,
  onInterject,
  onCancel,
}: {
  messages: QueuedMessage[];
  interjectedId: string | null;
  interjecting: boolean;
  onInterject: (eventId: string) => void;
  onCancel: (eventId: string) => void;
}) {
  const latest = messages.at(-1);
  if (!latest) return null;
  return (
    <HoverCard.Root openDelay={120} closeDelay={120}>
      <HoverCard.Trigger asChild>
        <div
          data-testid="queued-chip"
          className="flex min-w-0 items-center gap-2 rounded-lg border border-border bg-card/60 py-1 pl-3 pr-1.5 text-[11px]"
        >
          <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
            <MessageSquare aria-hidden className="size-3 shrink-0" />
            <span className="truncate">
              {messages.length > 1
                ? `${messages.length} messages queued`
                : "Message queued"}
            </span>
          </span>
          {interjectedId === latest.id ? (
            <span className="flex shrink-0 items-center gap-1.5 pl-1 pr-2 text-muted-foreground">
              <Loader2 aria-hidden className="size-3 animate-spin" />
              Interjected · stopping the run…
            </span>
          ) : (
            <Button
              size="sm"
              variant="outline"
              className="h-7 shrink-0 gap-1 px-2.5 text-[11px]"
              disabled={interjecting}
              onClick={() => onInterject(latest.id)}
            >
              <Zap aria-hidden className="size-3" />
              Interject
            </Button>
          )}
        </div>
      </HoverCard.Trigger>
      <HoverCard.Portal>
        <HoverCard.Content
          side="top"
          align="end"
          sideOffset={8}
          className="hover-card-in z-50 w-80 rounded-xl border border-border bg-card p-3 shadow-lg"
        >
          <p className="text-[11px] font-medium text-muted-foreground">
            {messages.length > 1
              ? `${messages.length} queued messages · combined into one batch`
              : "Queued message"}
          </p>
          <ul
            data-testid="queued-list"
            className="mt-2 max-h-64 space-y-2 overflow-y-auto"
          >
            {messages.map((message) => (
              <li
                key={message.id}
                className="rounded-lg border border-border p-2.5"
              >
                <div className="flex items-start justify-between gap-2">
                  <p className="min-w-0 whitespace-pre-wrap break-words text-xs leading-relaxed">
                    {message.body}
                  </p>
                  <button
                    type="button"
                    aria-label="Cancel queued message"
                    title="Cancel this message"
                    className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/30"
                    onClick={() => onCancel(message.id)}
                  >
                    <X aria-hidden className="size-3.5" />
                  </button>
                </div>
                <p className="mt-1 text-[10px] text-muted-foreground">
                  {timeAgo(message.at)}
                </p>
              </li>
            ))}
          </ul>
        </HoverCard.Content>
      </HoverCard.Portal>
    </HoverCard.Root>
  );
}
