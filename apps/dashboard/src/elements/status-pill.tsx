/**
 * StatusPill — restrained by design: neutral pill + a single semantic dot.
 * Only `running` gets a tint (it's the one live state worth attention);
 * everything else stays quiet so the page has ONE accent, not five.
 */
import { cn } from "@/utils/cn";

const DOT: Record<string, string> = {
  queued: "bg-slate-500",
  running: "bg-primary animate-pulse",
  pr_open: "bg-primary",
  succeeded: "bg-primary",
  merged: "bg-violet-400",
  waiting_ci: "bg-sky-400",
  fixing: "bg-amber-400",
  addressing_comments: "bg-violet-400",
  cancelled: "bg-amber-400",
  interrupted: "bg-orange-400",
  budget_exhausted: "bg-orange-400",
  failed: "bg-destructive",
  abandoned: "bg-destructive",
  paused: "bg-sky-400",
  closed: "bg-slate-600",
};

export function StatusPill({ status, className }: { status: string; className?: string }) {
  const running = status === "running";
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 font-mono text-[10.5px] tracking-wide",
        running
          ? "border-primary/40 bg-primary/10 text-primary"
          : "border-border/70 bg-transparent text-muted-foreground",
        className,
      )}
    >
      <span className={cn("size-1.5 shrink-0 rounded-full", DOT[status] ?? "bg-slate-500")} />
      {status.replace(/_/g, " ")}
    </span>
  );
}
