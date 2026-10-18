/**
 * Status primitives — thread states + run statuses as compact mono pills.
 * Tones are token-based (design-system/harness/MASTER.md): run-green = good,
 * amber = in flight / stopped gently, red = bad, violet = merged.
 */
import { cn } from "@/lib/utils";

const TONES: Record<string, string> = {
  // thread states
  queued: "border-border bg-muted/40 text-muted-foreground",
  running: "border-primary/40 bg-primary/10 text-primary",
  pr_open: "border-primary/40 bg-primary/10 text-primary",
  waiting_ci: "border-sky-400/40 bg-sky-400/10 text-sky-300",
  fixing: "border-amber-400/40 bg-amber-400/10 text-amber-300",
  addressing_comments: "border-violet-400/40 bg-violet-400/10 text-violet-300",
  merged: "border-violet-400/40 bg-violet-400/10 text-violet-300",
  closed: "border-border bg-muted/30 text-muted-foreground/80",
  abandoned: "border-destructive/40 bg-destructive/10 text-red-300",
  // run statuses
  succeeded: "border-primary/40 bg-primary/10 text-primary",
  failed: "border-destructive/40 bg-destructive/10 text-red-300",
  cancelled: "border-amber-400/40 bg-amber-400/10 text-amber-300",
  interrupted: "border-orange-400/40 bg-orange-400/10 text-orange-300",
  budget_exhausted: "border-orange-400/40 bg-orange-400/10 text-orange-300",
  paused: "border-sky-400/40 bg-sky-400/10 text-sky-300",
};

export function StatusPill({ status, className }: { status: string; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 font-mono text-[10.5px] font-medium tracking-wide",
        TONES[status] ?? "border-border bg-muted/40 text-muted-foreground",
        className,
      )}
    >
      {status === "running" && <span className="size-1.5 animate-pulse rounded-full bg-current" />}
      {status.replace(/_/g, " ")}
    </span>
  );
}
