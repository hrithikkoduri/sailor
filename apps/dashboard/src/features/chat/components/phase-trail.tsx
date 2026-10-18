import { Check, ChevronRight } from "lucide-react";
import { cn } from "@/utils/cn";

const label = (phase: string) =>
  phase.charAt(0).toUpperCase() + phase.slice(1);

/**
 * A quiet strip of the running run's approach: phases it entered, the current
 * one shimmering, later ones waiting. Honest about skips — only phases the
 * trace actually recorded as entered are marked visited.
 */
export function PhaseTrail({
  phases,
  visited,
  current,
}: {
  phases: string[];
  visited: string[];
  current: string | null;
}) {
  if (phases.length < 2) return null;
  return (
    <div
      data-testid="phase-trail"
      aria-label={`Agent phase: ${current ? label(current) : "starting"}`}
      className="inline-flex flex-wrap items-center gap-1.5 rounded-lg border border-border bg-card/60 px-3 py-1.5 text-[11px]"
    >
      {phases.map((phase, index) => {
        const isCurrent = phase === current;
        const isVisited = !isCurrent && visited.includes(phase);
        return (
          <span key={phase} className="flex items-center gap-1.5">
            {index > 0 && (
              <ChevronRight aria-hidden className="size-3 text-input" />
            )}
            <span
              data-phase-state={
                isCurrent ? "current" : isVisited ? "visited" : "upcoming"
              }
              aria-current={isCurrent ? "step" : undefined}
              className={cn(
                "flex items-center gap-1 transition-colors",
                isCurrent
                  ? "phase-shimmer font-semibold"
                  : "text-muted-foreground",
              )}
            >
              {isVisited && <Check aria-hidden className="size-2.5" />}
              {label(phase)}
            </span>
          </span>
        );
      })}
    </div>
  );
}
