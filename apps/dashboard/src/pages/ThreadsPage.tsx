/** Threads — every issue conversation the agent has, newest first. */
import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { motion } from "motion/react";
import { GitPullRequest, Inbox, RefreshCw } from "lucide-react";
import { ApiError, getThreads, type ThreadListItem } from "@/api";
import { AppShell } from "@/components/app-shell";
import { StatusPill } from "@/components/status";
import { Skeleton } from "@/components/ui/skeleton";
import { fmtUsd, timeAgo } from "@/lib/format";

const listVariants = { hidden: {}, show: { transition: { staggerChildren: 0.045 } } };
const rowVariants = { hidden: { opacity: 0, y: 8 }, show: { opacity: 1, y: 0 } };

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

  useEffect(() => {
    void load();
    const timer = window.setInterval(load, 5_000);
    return () => window.clearInterval(timer);
  }, [load]);

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
            <div className="mt-16 flex flex-col items-center gap-4 text-center">
              <span className="flex size-12 items-center justify-center rounded-2xl border border-border bg-card/60">
                <Inbox className="size-5 text-muted-foreground" />
              </span>
              <div>
                <h2 className="font-medium">No threads yet</h2>
                <p className="mt-1 max-w-sm text-sm text-muted-foreground">
                  Enable a repository in Settings, then label an issue — the agent picks it up and opens the PR.
                </p>
              </div>
              <Link
                to="/settings"
                className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
              >
                Open Settings
              </Link>
            </div>
          ) : (
            <motion.div initial="hidden" animate="show" variants={listVariants} className="mt-7 space-y-2.5">
              {threads.map((t) => (
                <motion.div key={t.id} variants={rowVariants}>
                  <Link
                    to={`/threads/${t.id}`}
                    className="group flex items-center gap-4 rounded-xl border border-border/70 bg-card/40 px-4 py-3.5 transition-all duration-200 hover:border-border hover:bg-card"
                  >
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-muted/50 font-mono text-[11px] font-semibold uppercase text-muted-foreground">
                      {(t.repo.split("/").pop() ?? t.repo).slice(0, 2)}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                        <span className="truncate text-sm font-medium text-foreground">{t.repo}</span>
                        <span className="font-mono text-xs text-muted-foreground">#{t.issueNumber}</span>
                        <StatusPill status={t.state} />
                        {t.latestRun && <StatusPill status={t.latestRun.status} />}
                        {t.latestRun?.phase && (
                          <span className="font-mono text-[10.5px] text-muted-foreground">{t.latestRun.phase}</span>
                        )}
                        {t.pendingEvents > 0 && (
                          <span className="rounded-full border border-amber-400/40 bg-amber-400/10 px-2 py-0.5 font-mono text-[10.5px] text-amber-300">
                            {t.pendingEvents} pending
                          </span>
                        )}
                      </div>
                      <p className="mt-1 truncate text-xs text-muted-foreground">
                        {t.summary ?? t.latestRun?.task ?? "waiting for the first turn"}
                      </p>
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-1.5 font-mono text-[10.5px] text-muted-foreground">
                      <span>{timeAgo(t.updatedAt)}</span>
                      <span className="flex items-center gap-2">
                        <span>
                          {t.turnsUsed}/{t.budgetMaxTurns} turns · {fmtUsd(t.usdSpent)}
                        </span>
                        {t.prUrl && (
                          <span
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              window.open(t.prUrl!, "_blank");
                            }}
                            className="inline-flex cursor-pointer items-center gap-1 rounded-md border border-primary/30 bg-primary/10 px-1.5 py-0.5 text-primary transition-colors hover:bg-primary/20"
                          >
                            <GitPullRequest className="size-3" /> #{t.prNumber}
                          </span>
                        )}
                      </span>
                    </div>
                  </Link>
                </motion.div>
              ))}
            </motion.div>
          )}
        </div>
      </div>
    </AppShell>
  );
}
