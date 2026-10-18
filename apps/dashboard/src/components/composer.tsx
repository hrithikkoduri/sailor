/**
 * ChatComposer — where the operator talks to the agent.
 *
 * Enter sends (the message becomes an inbox event; while a run is busy the
 * server queues it behind the active turn). Press Enter again right after —
 * on the now-empty box — to INTERJECT: the active run stops at its next
 * boundary and the queued message becomes the next turn (decision #28).
 */
import { useRef, useState } from "react";
import { ArrowUp, CornerDownLeft, Zap } from "lucide-react";
import { interjectEvent } from "@/api";
import { cn } from "@/lib/utils";

export function ChatComposer({
  busy,
  disabled,
  placeholder,
  onSend,
}: {
  /** An active (queued/running) run exists. */
  busy: boolean;
  /** Thread is terminal — no more turns. */
  disabled?: boolean;
  placeholder?: string;
  onSend: (text: string, opts: { interject: boolean }) => Promise<{ eventId: string } | undefined>;
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [lastEventId, setLastEventId] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  const autosize = () => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  };

  const say = (message: string) => {
    setFlash(message);
    window.setTimeout(() => setFlash(null), 4500);
  };

  const submit = async () => {
    const trimmed = text.trim();
    if (!trimmed || sending || disabled) return;
    setSending(true);
    const res = await onSend(trimmed, { interject: false });
    setSending(false);
    if (res) {
      setText("");
      setLastEventId(res.eventId);
      if (taRef.current) taRef.current.style.height = "auto";
      say(busy ? "Queued — press ⏎ again to interject it now." : "Sent — the agent is on it.");
      taRef.current?.focus();
    }
  };

  const interjectLast = async () => {
    if (!lastEventId || sending) return;
    setSending(true);
    const res = await interjectEvent(lastEventId).catch(() => undefined);
    setSending(false);
    if (res) {
      say("Interjected — the queued message becomes the next turn.");
      setLastEventId(null);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== "Enter" || e.shiftKey) return;
    e.preventDefault();
    if (busy && !text.trim() && lastEventId) {
      void interjectLast();
      return;
    }
    void submit();
  };

  return (
    <div className="mx-auto w-full max-w-3xl px-4 pb-4">
      <div
        className={cn(
          "rounded-xl border border-border bg-card/70 shadow-lg shadow-black/20 backdrop-blur transition-colors",
          "focus-within:border-primary/40",
          disabled && "opacity-60",
        )}
      >
        <textarea
          ref={taRef}
          value={text}
          disabled={disabled || sending}
          onChange={(e) => {
            setText(e.target.value);
            autosize();
          }}
          onKeyDown={onKeyDown}
          rows={1}
          placeholder={disabled ? "This thread takes no more turns." : (placeholder ?? "Message the agent…")}
          className="block w-full resize-none bg-transparent px-4 pt-3 pb-1 text-sm leading-relaxed text-foreground outline-none placeholder:text-muted-foreground/70"
        />
        <div className="flex items-center justify-between gap-3 px-3 pb-2.5">
          <div className="flex min-w-0 items-center gap-3 text-[11px] text-muted-foreground">
            {flash ? (
              <span className="truncate text-primary">{flash}</span>
            ) : busy ? (
              <span className="flex items-center gap-1.5">
                <span className="size-1.5 animate-pulse rounded-full bg-primary" />
                agent is working — <CornerDownLeft className="size-3" /> queues, double-⏎ interjects
              </span>
            ) : (
              <span className="flex items-center gap-1.5">
                <CornerDownLeft className="size-3" />
                send · shift+⏎ for a new line
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {busy && lastEventId && !flash && (
              <button
                onClick={() => void interjectLast()}
                className="flex cursor-pointer items-center gap-1.5 rounded-lg border border-amber-400/40 bg-amber-400/10 px-2.5 py-1 text-[11px] font-medium text-amber-300 transition-colors hover:bg-amber-400/20"
              >
                <Zap className="size-3" /> Interject
              </button>
            )}
            <button
              onClick={() => void submit()}
              disabled={disabled || sending || text.trim().length === 0}
              aria-label="Send message"
              className={cn(
                "flex size-8 cursor-pointer items-center justify-center rounded-lg bg-primary text-primary-foreground transition-all",
                "hover:bg-primary/90 disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground",
              )}
            >
              <ArrowUp className="size-4" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
