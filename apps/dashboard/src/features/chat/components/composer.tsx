import { useRef, useState, type KeyboardEvent } from "react";
import { ArrowUp, Command, CornerDownLeft, Loader2, Zap } from "lucide-react";
import { interjectEvent } from "@/features/chat/api";
import { Button } from "@/elements/button";

export function ChatComposer({
  busy,
  disabled,
  placeholder,
  onSend,
}: {
  busy: boolean;
  disabled?: boolean;
  placeholder?: string;
  onSend: (
    text: string,
    opts: { interject: boolean },
  ) => Promise<{ eventId: string } | undefined>;
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [lastEventId, setLastEventId] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const textarea = useRef<HTMLTextAreaElement>(null);

  const send = async () => {
    if (!text.trim() || sending || disabled) return;
    setSending(true);
    setError("");
    try {
      const result = await onSend(text.trim(), { interject: false });
      if (!result) return;
      setText("");
      setLastEventId(busy ? result.eventId : null);
      setNotice(
        busy
          ? "Message queued. Press Enter again to interject."
          : "Message sent.",
      );
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
  const interject = async () => {
    if (!lastEventId || sending) return;
    setSending(true);
    setError("");
    try {
      await interjectEvent(lastEventId);
      setLastEventId(null);
      setNotice("Interjected. The agent will pick this up next.");
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Could not interject this message.",
      );
    } finally {
      setSending(false);
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
    if (busy && !text.trim() && lastEventId) void interject();
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
            setNotice("");
            e.target.style.height = "auto";
            e.target.style.height = `${Math.min(e.target.scrollHeight, 180)}px`;
          }}
          className="block min-h-10 w-full resize-none bg-transparent px-1.5 py-1 text-sm leading-relaxed outline-none placeholder:text-muted-foreground focus-visible:outline-none"
        />
        <div className="mt-2 flex items-center justify-between gap-2">
          <span className="flex items-center gap-1.5 px-1.5 text-[11px] text-muted-foreground">
            <Command className="size-3" />
            {busy
              ? "Agent working · messages are queued"
              : "A conversation with your agent"}
          </span>
          <div className="flex items-center gap-2">
            {busy && lastEventId && (
              <Button
                size="sm"
                variant="outline"
                className="h-8 text-xs"
                disabled={sending}
                onClick={() => void interject()}
              >
                <Zap className="size-3" />
                Interject
              </Button>
            )}
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
      </div>
      {error ? (
        <p role="alert" className="mt-2 px-1 text-xs text-destructive">
          {error}
        </p>
      ) : (
        <div className="mt-2 flex justify-between gap-2 px-1 text-[10px] text-muted-foreground">
          <span aria-live="polite">
            {notice || "Your messages stay with this conversation."}
          </span>
          <span className="hidden shrink-0 items-center gap-1 sm:flex">
            <CornerDownLeft className="size-2.5" /> Send · Shift + Enter for a
            new line
          </span>
        </div>
      )}
    </div>
  );
}
