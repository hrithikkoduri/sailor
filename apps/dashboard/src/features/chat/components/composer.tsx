import { useRef, useState, type KeyboardEvent } from "react";
import { ArrowUp, CornerDownLeft, Loader2 } from "lucide-react";
import { Button } from "@/elements/button";

/**
 * The composer writes and sends; it owns no queue state. The queued message,
 * its Interject action, and the run's phase trail live together on the row
 * above (thread-detail-page) — one place that reflects server truth.
 */
export function ChatComposer({
  busy,
  disabled,
  placeholder,
  queuedEventId,
  onInterject,
  onSend,
}: {
  busy: boolean;
  disabled?: boolean;
  placeholder?: string;
  /** The pending dashboard message an empty-Enter press will interject. */
  queuedEventId?: string | null;
  onInterject?: () => void;
  onSend: (text: string) => Promise<void>;
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const textarea = useRef<HTMLTextAreaElement>(null);

  const send = async () => {
    if (!text.trim() || sending || disabled) return;
    setSending(true);
    setError("");
    try {
      await onSend(text.trim());
      setText("");
      if (textarea.current) textarea.current.style.height = "auto";
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Could not send. Your message is still here.",
      );
    } finally {
      setSending(false);
      textarea.current?.focus();
    }
  };
  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (
      event.nativeEvent.isComposing ||
      event.key !== "Enter" ||
      event.shiftKey
    )
      return;
    event.preventDefault();
    // Decision #47: Enter queues; Enter again on an empty box interjects.
    if (busy && !text.trim() && queuedEventId && onInterject)
      void onInterject();
    else void send();
  };

  return (
    <div className="mx-auto w-full max-w-[800px] px-5 pb-4 pt-3 sm:px-8 sm:pb-5">
      <div className="rounded-2xl border border-input bg-card p-3 shadow-[0_4px_24px_-12px_#0002] transition-shadow focus-within:ring-2 focus-within:ring-ring/15">
        <textarea
          ref={textarea}
          aria-label="Message the agent"
          value={text}
          disabled={disabled}
          rows={1}
          onKeyDown={keyDown}
          placeholder={
            disabled
              ? "This thread is closed."
              : (placeholder ??
                "Ask a question, share context, or give direction…")
          }
          onChange={(e) => {
            setText(e.target.value);
            e.target.style.height = "auto";
            e.target.style.height = `${Math.min(e.target.scrollHeight, 180)}px`;
          }}
          className="block min-h-10 w-full resize-none bg-transparent px-1.5 py-1 text-sm leading-relaxed outline-none placeholder:text-muted-foreground focus-visible:outline-none"
        />
        <div className="mt-2 flex items-center justify-between gap-2">
          <span className="px-1.5 text-[11px] text-muted-foreground">
            {busy
              ? "Agent working — your message will queue"
              : "A conversation with your agent"}
          </span>
          <Button
            size="icon-sm"
            aria-label="Send message"
            className="rounded-lg"
            disabled={disabled || sending || !text.trim()}
            onClick={() => void send()}
          >
            {sending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <ArrowUp className="size-4" />
            )}
          </Button>
        </div>
      </div>
      {error ? (
        <p role="alert" className="mt-2 px-1 text-xs text-destructive">
          {error}
        </p>
      ) : (
        <div className="mt-2 flex justify-between gap-2 px-1 text-[10px] text-muted-foreground">
          <span>Your messages stay with this conversation.</span>
          <span className="hidden shrink-0 items-center gap-1 sm:flex">
            <CornerDownLeft className="size-2.5" /> Send · Shift + Enter for a
            new line
          </span>
        </div>
      )}
    </div>
  );
}
