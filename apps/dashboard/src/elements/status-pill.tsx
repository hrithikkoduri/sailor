import { cn } from "@/utils/cn";

const LABELS: Record<string, string> = {
  pr_open: "PR open",
  waiting_ci: "Waiting for checks",
  addressing_comments: "In review",
  budget_exhausted: "Budget reached",
  waiting_for_input: "Waiting for you",
};
export function StatusPill({
  status,
  className,
}: {
  status: string;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-md bg-muted/70 px-2 py-1 text-[11px] font-medium text-muted-foreground",
        className,
      )}
    >
      <span
        className={cn(
          "size-1.5 rounded-full bg-muted-foreground/60",
          ["running", "succeeded", "pr_open"].includes(status) && "bg-success",
          status === "running" && "animate-pulse",
          status === "failed" && "bg-destructive",
        )}
      />
      {LABELS[status] ??
        status.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase())}
    </span>
  );
}
