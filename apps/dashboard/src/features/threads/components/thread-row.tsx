/** One thread in the list — monogram, state, latest run, budgets, PR. */
import { Link } from "react-router-dom";
import { motion } from "motion/react";
import { GitPullRequest } from "lucide-react";
import type { ThreadListItem } from "@/features/threads/api";
import { StatusPill } from "@/elements/status-pill";
import { fmtUsd, timeAgo } from "@/utils/format";

export const rowVariants = { hidden: { opacity: 0, y: 8 }, show: { opacity: 1, y: 0 } };

export function ThreadRow({ thread }: { thread: ThreadListItem }) {
  const monogram = (thread.repo.split("/").pop() ?? thread.repo).slice(0, 2);
  return (
    <motion.div variants={rowVariants}>
      <Link
        to={`/threads/${thread.id}`}
        className="group flex items-center gap-4 rounded-xl border border-border/70 bg-card/40 px-4 py-3.5 transition-all duration-200 hover:border-border hover:bg-card"
      >
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-muted/50 font-mono text-[11px] font-semibold uppercase text-muted-foreground">
          {monogram}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
            <span className="truncate text-sm font-medium text-foreground">{thread.repo}</span>
            <span className="font-mono text-xs text-muted-foreground">#{thread.issueNumber}</span>
            <StatusPill status={thread.state} />
            {thread.latestRun && <StatusPill status={thread.latestRun.status} />}
            {thread.latestRun?.phase && (
              <span className="font-mono text-[10.5px] text-muted-foreground">{thread.latestRun.phase}</span>
            )}
            {thread.pendingEvents > 0 && (
              <span className="rounded-full border border-amber-400/40 bg-amber-400/10 px-2 py-0.5 font-mono text-[10.5px] text-amber-300">
                {thread.pendingEvents} pending
              </span>
            )}
          </div>
          <p className="mt-1 truncate text-xs text-muted-foreground">
            {thread.summary ?? thread.latestRun?.task ?? "waiting for the first turn"}
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1.5 font-mono text-[10.5px] text-muted-foreground">
          <span>{timeAgo(thread.updatedAt)}</span>
          <span className="flex items-center gap-2">
            <span>
              {thread.turnsUsed}/{thread.budgetMaxTurns} turns · {fmtUsd(thread.usdSpent)}
            </span>
            {thread.prUrl && (
              <span
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  window.open(thread.prUrl!, "_blank");
                }}
                className="inline-flex cursor-pointer items-center gap-1 rounded-md border border-primary/30 bg-primary/10 px-1.5 py-0.5 text-primary transition-colors hover:bg-primary/20"
              >
                <GitPullRequest className="size-3" /> #{thread.prNumber}
              </span>
            )}
          </span>
        </div>
      </Link>
    </motion.div>
  );
}
