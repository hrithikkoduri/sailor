import { useState } from "react";
import { Loader2, X, Zap } from "lucide-react";
import { Button } from "@/elements/button";
import { cn } from "@/utils/cn";

export interface QueuedMessage {
  id: string;
  body: string;
  at: string;
}

/**
 * The queued dashboard messages, as themselves: overlapping user bubbles
 * sitting on the phase row. Nothing has been delivered yet, so the thread
 * does not carry them — they stack here until a turn picks them up, or
 * Interject stops the run so they land next. Hover (or keyboard focus) fans
 * the stack into the full bubbles, each with its own withdraw. When a message
 * lands, the conversation animates it into place.
 */
export function QueuedBubbles({
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
  const [open, setOpen] = useState(false);
  const latest = messages.at(-1);
  if (!latest) return null;
  const stopping = interjectedId === latest.id;
  return (
    <div
      data-testid="queued-bubbles"
      role="group"
      aria-label={
        messages.length > 1
          ? `${messages.length} messages queued`
          : "Message queued"
      }
      className="flex max-w-[60vw] min-w-0 flex-col items-end sm:max-w-[360px]"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null))
          setOpen(false);
      }}
    >
      {open ? (
        <ul
          data-testid="queued-list"
          className="flex max-h-64 flex-col items-end gap-2 overflow-y-auto"
        >
          {messages.map((message) => (
            <li
              key={message.id}
              className="hover-card-in flex w-fit max-w-full items-start gap-1.5 self-end"
            >
              <div className="max-w-[280px] min-w-0 rounded-2xl rounded-br-md bg-muted px-4 py-2.5 text-[13px] leading-relaxed break-words whitespace-pre-wrap">
                {message.body}
              </div>
              <button
                type="button"
                aria-label="Cancel queued message"
                title="Cancel this message"
                className="mt-1.5 shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/30"
                onClick={() => onCancel(message.id)}
              >
                <X aria-hidden className="size-3.5" />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        // The deck: the newest bubble up front, older ones peeking above it.
        <div className="relative mt-4 mr-1">
          {messages.slice(-3).map((message, i, arr) => {
            const level = arr.length - 1 - i;
            return (
              <div
                key={message.id}
                className={cn(
                  "max-w-[320px] truncate rounded-2xl rounded-br-md bg-muted px-4 py-2.5 text-[13px] shadow-sm",
                  level > 0 ? "absolute top-0 right-0" : "relative",
                )}
                style={
                  level > 0
                    ? {
                        // Zig-zag deck: alternating tilt and sideways peek.
                        transform: `translate(${level % 2 === 1 ? -10 : 10}px, -${level * 8}px) rotate(${level % 2 === 1 ? -3.5 : 3.5}deg) scale(${1 - level * 0.04})`,
                        opacity: 0.7 - (level - 1) * 0.25,
                        zIndex: 0,
                      }
                    : { zIndex: 1 }
                }
              >
                {message.body}
              </div>
            );
          })}
        </div>
      )}
      <div className="mt-1 flex items-center gap-1.5">
        {stopping ? (
          <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <Loader2 aria-hidden className="size-3 animate-spin" />
            Interjected · stopping the run…
          </span>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            className="h-6 gap-1 px-2 text-[11px] text-muted-foreground"
            disabled={interjecting}
            onClick={() => onInterject(latest.id)}
          >
            <Zap aria-hidden className="size-3" />
            Interject
          </Button>
        )}
      </div>
    </div>
  );
}
