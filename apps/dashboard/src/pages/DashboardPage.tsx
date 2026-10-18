import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, ApiError, type OnboardingData } from "../api";
import { Wordmark } from "../components/brand";

export function DashboardPage() {
  const navigate = useNavigate();
  const [data, setData] = useState<OnboardingData | null>(null);

  useEffect(() => {
    api<OnboardingData>("/api/onboarding")
      .then(setData)
      .catch((err: unknown) => {
        if (err instanceof ApiError && err.status === 401) navigate("/login");
      });
  }, [navigate]);

  const enabledRepos =
    data?.installations.flatMap((i) => i.repos.filter((r) => r.enabled).map((r) => r.fullName)) ?? [];

  return (
    <div className="bg-aura min-h-dvh">
      <header className="mx-auto flex max-w-4xl items-center justify-between px-6 py-6">
        <Wordmark />
        {data?.user && (
          <span className="text-sm text-zinc-400">{data.user.name ?? data.user.login ?? data.user.email}</span>
        )}
      </header>

      <main className="mx-auto max-w-4xl px-6 pb-20">
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>

        {data === null ? (
          <p className="mt-2 text-sm text-zinc-500">Loading…</p>
        ) : enabledRepos.length === 0 ? (
          <div className="mt-8 rounded-2xl border border-white/10 bg-white/[0.03] p-8">
            <h2 className="font-medium">No repos enabled yet</h2>
            <p className="mt-1 text-sm text-zinc-400">Finish onboarding to choose which repos the agent may work on.</p>
            <Link
              to="/onboarding"
              className="mt-5 inline-block rounded-lg bg-indigo-500 px-5 py-2.5 text-sm font-medium text-white transition hover:bg-indigo-400"
            >
              Continue onboarding
            </Link>
          </div>
        ) : (
          <>
            <div className="mt-6 flex flex-wrap gap-2">
              {enabledRepos.map((repo) => (
                <span
                  key={repo}
                  className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 font-mono text-xs text-zinc-300"
                >
                  {repo}
                </span>
              ))}
            </div>

            <div className="mt-10 rounded-2xl border border-white/10 bg-white/[0.03] p-8">
              <h2 className="font-medium">Threads, runs, and live traces land here next</h2>
              <p className="mt-1.5 text-sm leading-relaxed text-zinc-400">
                Step 17b wires this page to the real data: every thread from your issues, each run's phases and
                tool calls, token cost, and a live SSE stream while the agent works — plus the Interject button.
              </p>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
