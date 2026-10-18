/** The threads list — every issue the agent has picked up, newest first. */
import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ApiError, getThreads, type ThreadListItem } from "../api";
import { Shell } from "../components/Shell";
import { fmtUsd, RunStatusPill, StatePill, timeAgo } from "../components/badges";

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
    const timer = window.setInterval(load, 5_000); // gentle poll; per-thread SSE lives on the detail page
    return () => window.clearInterval(timer);
  }, [load]);

  return (
    <Shell>
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Threads</h1>
          <p className="mt-1 text-sm text-zinc-400">
            One thread per issue — the agent picks it up when you label it{" "}
            <span className="rounded bg-white/10 px-1.5 py-0.5 font-mono text-xs">agent:fix</span>.
          </p>
        </div>
        <button onClick={() => void load()} className="rounded-lg border border-white/10 bg-white/[0.03] px-3 py-1.5 text-sm text-zinc-300 transition hover:bg-white/[0.07]">
          Refresh
        </button>
      </div>

      {threads === null ? (
        <p className="mt-10 text-sm text-zinc-500">Loading…</p>
      ) : threads.length === 0 ? (
        <div className="mt-10 rounded-2xl border border-white/10 bg-white/[0.03] p-8">
          <h2 className="font-medium">No threads yet</h2>
          <p className="mt-1 text-sm text-zinc-400">
            Enable a repo in onboarding, then create an issue there and label it{" "}
            <span className="rounded bg-white/10 px-1.5 py-0.5 font-mono text-xs">agent:fix</span>.
          </p>
          <Link to="/onboarding" className="mt-5 inline-block rounded-lg bg-indigo-500 px-5 py-2.5 text-sm font-medium text-white transition hover:bg-indigo-400">
            Finish onboarding
          </Link>
        </div>
      ) : (
        <div className="mt-8 overflow-hidden rounded-2xl border border-white/10">
          {threads.map((t) => (
            <Link
              key={t.id}
              to={`/threads/${t.id}`}
              className="flex items-center justify-between gap-4 border-b border-white/5 bg-white/[0.02] px-5 py-4 transition last:border-b-0 hover:bg-white/[0.05]"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-3">
                  <span className="truncate font-medium text-zinc-100">{t.repo}</span>
                  <span className="font-mono text-xs text-zinc-500">#{t.issueNumber}</span>
                  <StatePill state={t.state} />
                </div>
                <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-500">
                  {t.latestRun && (
                    <>
                      <RunStatusPill status={t.latestRun.status} />
                      {t.latestRun.phase && <span>phase: {t.latestRun.phase}</span>}
                    </>
                  )}
                  <span>
                    turn {t.turnsUsed}/{t.budgetMaxTurns}
                  </span>
                  <span>{fmtUsd(t.usdSpent)}</span>
                  {t.pendingEvents > 0 && (
                    <span className="rounded-full border border-amber-400/40 bg-amber-500/10 px-2 py-0.5 text-amber-200">
                      {t.pendingEvents} pending event{t.pendingEvents === 1 ? "" : "s"}
                    </span>
                  )}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-4 text-xs text-zinc-500">
                {t.prUrl && (
                  <span
                    onClick={(e) => {
                      e.preventDefault();
                      window.open(t.prUrl!, "_blank");
                    }}
                    className="rounded-full border border-emerald-400/40 bg-emerald-500/10 px-2.5 py-1 text-emerald-200 transition hover:bg-emerald-500/20"
                  >
                    PR #{t.prNumber} ↗
                  </span>
                )}
                <span>{timeAgo(t.updatedAt)}</span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </Shell>
  );
}
