/** The rail's run list — every turn on the thread, newest first. */
import type { ThreadRun } from "@/features/threads/api";
import { StatusPill } from "@/elements/status-pill";
import { timeAgo } from "@/utils/format";
import { cn } from "@/utils/cn";

export function RunsList({
  runs,
  selectedRunId,
  onSelect,
}: {
  runs: ThreadRun[];
  selectedRunId: string | null;
  onSelect: (runId: string) => void;
}) {
  return (
    <section>
      <h3 className="font-mono text-[10.5px] tracking-widest text-muted-foreground uppercase">Runs ({runs.length})</h3>
      <div className="mt-3 space-y-1.5">
        {runs.map((run) => (
          <button
            key={run.id}
            onClick={() => onSelect(run.id)}
            className={cn(
              "w-full cursor-pointer rounded-lg border px-3 py-2 text-left transition-colors",
              selectedRunId === run.id
                ? "border-primary/40 bg-primary/10"
                : "border-border/70 bg-card/30 hover:bg-card/60",
            )}
          >
            <div className="flex items-center gap-2">
              <StatusPill status={run.status} />
              <span className="ml-auto font-mono text-[10.5px] text-muted-foreground">{timeAgo(run.createdAt)}</span>
            </div>
            <div className="mt-1 truncate font-mono text-[10.5px] text-muted-foreground">
              {run.agent === "chat" ? "chat · " : ""}
              {run.trigger}
              {run.phase ? ` · ${run.phase}` : ""}
            </div>
          </button>
        ))}
      </div>
    </section>
  );
}
