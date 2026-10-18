/** Threads — every issue conversation the agent has, newest first. */
import { useCallback, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { motion } from "motion/react";
import { Inbox, RefreshCw } from "lucide-react";
import { getThreads, type ThreadListItem } from "@/features/threads/api";
import { ThreadRow } from "@/features/threads/components/thread-row";
import { AppShell } from "@/features/shell/app-shell";
import { EmptyState } from "@/elements/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { usePoll } from "@/hooks/use-poll";
import { ApiError } from "@/utils/api-client";

const listVariants = { hidden: {}, show: { transition: { staggerChildren: 0.045 } } };

export function ThreadsPage() {
  const navigate = useNavigate();
  const [threads, setThreads] = useState<ThreadListItem[] | null>(null);

  const load = useCallback(async () => {
    try {
      setThreads((await getThreads()).threads);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) navigate("/login");
    }
  }, [navigate]);

  usePoll(load, 5_000);

  const active = threads?.filter((t) => t.latestRun && ["running", "queued"].includes(t.latestRun.status)).length ?? 0;
  const pending = threads?.reduce((n, t) => n + t.pendingEvents, 0) ?? 0;

  return (
    <AppShell
      topbar={<span className="font-mono text-[11.5px] tracking-wide text-muted-foreground">workspace / threads</span>}
    >
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-5xl px-6 py-8">
          <header className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <h1 className="font-mono text-xl font-semibold tracking-tight">Threads</h1>
              <p className="mt-1.5 text-sm text-muted-foreground">
                One conversation per issue — label it{" "}
                <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-primary">agent:fix</span> on
                GitHub to start one.
              </p>
            </div>
            <div className="flex items-center gap-2">
              {threads && threads.length > 0 && (
                <div className="mr-1 flex items-center gap-3 font-mono text-[11px] text-muted-foreground">
                  <span>
                    <span className={active > 0 ? "text-primary" : ""}>{active}</span> active
                  </span>
                  <span>
                    <span className={pending > 0 ? "text-amber-300" : ""}>{pending}</span> pending
                  </span>
                  <span>{threads.length} total</span>
                </div>
              )}
              <button
                onClick={() => void load()}
                aria-label="Refresh"
                className="flex size-8 cursor-pointer items-center justify-center rounded-lg border border-border text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <RefreshCw className="size-3.5" />
              </button>
            </div>
          </header>

          {threads === null ? (
            <div className="mt-8 space-y-2.5">
              {[0, 1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-[86px] rounded-xl bg-card/60" />
              ))}
            </div>
          ) : threads.length === 0 ? (
            <EmptyState
              icon={Inbox}
              title="No threads yet"
              description="Enable a repository in Settings, then label an issue — the agent picks it up and opens the PR."
            >
              <Link
                to="/settings"
                className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
              >
                Open Settings
              </Link>
            </EmptyState>
          ) : (
            <motion.div initial="hidden" animate="show" variants={listVariants} className="mt-7 space-y-2.5">
              {threads.map((thread) => (
                <ThreadRow key={thread.id} thread={thread} />
              ))}
            </motion.div>
          )}
        </div>
      </div>
    </AppShell>
  );
}
