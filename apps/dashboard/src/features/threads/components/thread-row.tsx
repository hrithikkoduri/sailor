import { Link } from "react-router-dom";
import { ChevronRight, GitPullRequest, MessageSquare } from "lucide-react";
import type { ThreadListItem } from "@/features/threads/api";
import { StatusPill } from "@/elements/status-pill";
import { timeAgo } from "@/utils/format";

export function ThreadRow({ thread }: { thread: ThreadListItem }) {
  const repo = thread.repo.split("/").pop() ?? thread.repo;
  const title =
    thread.latestRun?.task?.match(/^Fix GitHub issue #\d+: ([^\n]+)/)?.[1] ??
    `Issue #${thread.issueNumber}`;
  return (
    <div className="group flex min-w-0 items-center gap-3 border-b border-border px-4 py-4 transition-colors last:border-b-0 hover:bg-muted/40 sm:px-5">
      <span className="hidden size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-background sm:flex">
        <MessageSquare className="size-4 text-muted-foreground" />
      </span>
      <Link
        to={`/threads/${thread.id}`}
        className="min-w-0 flex-1 outline-offset-4"
      >
        <div className="flex items-center gap-2">
          <h2 className="truncate text-sm font-medium tracking-[-.01em]">
            {title}
          </h2>
          {thread.pendingEvents > 0 && (
            <span className="shrink-0 text-[11px] text-muted-foreground">
              {thread.pendingEvents} queued
            </span>
          )}
        </div>
        <p className="mt-1 flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
          <span className="truncate">{repo}</span>
          <span>·</span>
          <span>#{thread.issueNumber}</span>
          <span className="hidden sm:inline">
            · {timeAgo(thread.updatedAt)}
          </span>
        </p>
      </Link>
      <StatusPill
        status={
          thread.latestRun?.status === "running" ? "running" : thread.state
        }
      />
      {thread.prUrl && (
        <a
          href={thread.prUrl}
          target="_blank"
          rel="noreferrer"
          aria-label={`Open pull request ${thread.prNumber}`}
          className="hidden items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent md:flex"
        >
          <GitPullRequest className="size-3.5" />#{thread.prNumber}
        </a>
      )}
      <ChevronRight className="size-3.5 shrink-0 text-muted-foreground/50" />
    </div>
  );
}
