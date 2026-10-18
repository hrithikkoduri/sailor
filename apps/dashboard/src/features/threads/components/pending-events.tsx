/** Pending events with the explicit Interject override (decision #28). */
import { Zap } from "lucide-react";
import type { PendingEvent } from "@/features/threads/api";
import { eventPreview } from "@/utils/events";
import { timeAgo } from "@/utils/format";

export function PendingEvents({
  events,
  busyKey,
  onInterject,
}: {
  events: PendingEvent[];
  busyKey: string | null;
  onInterject: (event: PendingEvent) => void;
}) {
  if (events.length === 0) return null;
  return (
    <section>
      <h3 className="font-mono text-[10.5px] tracking-widest text-muted-foreground uppercase">
        Pending ({events.length})
      </h3>
      <div className="mt-3 space-y-2">
        {events.map((event) => (
          <div key={event.id} className="rounded-lg border border-border/70 bg-muted/20 px-3 py-2.5">
            <div className="flex items-center gap-2 font-mono text-[10.5px] text-muted-foreground">
              <span>{event.kind}</span>
              <span className="text-muted-foreground/60">{timeAgo(event.receivedAt)}</span>
            </div>
            <div className="mt-1 line-clamp-2 text-xs text-slate-300">
              {eventPreview(event.kind, event.payload).slice(0, 200)}
            </div>
            <button
              onClick={() => onInterject(event)}
              disabled={busyKey !== null}
              className="mt-2 flex cursor-pointer items-center gap-1.5 rounded-md border border-amber-400/50 bg-amber-400/15 px-2 py-1 text-[11px] text-amber-100 transition-colors hover:bg-amber-400/25 disabled:opacity-50"
            >
              <Zap className="size-3" /> Interject
            </button>
          </div>
        ))}
      </div>
      <p className="mt-2 text-[10.5px] leading-relaxed text-muted-foreground/80">
        Interjecting stops the active run at its next boundary — the event becomes the next turn.
      </p>
    </section>
  );
}
