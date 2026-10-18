/** Settings — GitHub connection + the repo gate, in the product-suite chrome. */
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { getGate, type GateData } from "@/features/repos/api";
import { RepoPicker } from "@/features/repos/components/repo-picker";
import { AppShell } from "@/features/shell/app-shell";
import { GithubMark } from "@/elements/brand";
import { ApiError } from "@/utils/api-client";

export function SettingsPage() {
  const navigate = useNavigate();
  const [data, setData] = useState<GateData | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await getGate());
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) navigate("/login");
      else setError("Could not load settings.");
    }
  }, [navigate]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <AppShell
      topbar={<span className="font-mono text-[11.5px] tracking-wide text-muted-foreground">workspace / settings</span>}
    >
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl space-y-6 px-6 py-8">
          <header>
            <h1 className="font-mono text-xl font-semibold tracking-tight">Settings</h1>
            <p className="mt-1.5 text-sm text-muted-foreground">What the agent may work on, and how it gets access.</p>
          </header>

          {error && (
            <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-2.5 text-sm text-red-300">
              {error}
            </div>
          )}

          {data === null ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : (
            <>
              {/* GitHub */}
              <section className="rounded-xl border border-border/70 bg-card/40 p-5">
                <h2 className="text-sm font-semibold">GitHub</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  The agent works through a GitHub App installation — its own bot identity, scoped to what you chose.
                </p>
                {!data.githubAppConfigured && (
                  <div className="mt-3 rounded-lg border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-xs text-amber-200">
                    The server has no GitHub App configured (set <code className="font-mono">GITHUB_APP_*</code> in{" "}
                    <code className="font-mono">.env</code>).
                  </div>
                )}
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  {data.installations.length === 0 ? (
                    <span className="text-sm text-muted-foreground">No installation yet.</span>
                  ) : (
                    data.installations.map((inst) => (
                      <span
                        key={inst.installationId}
                        className="flex items-center gap-1.5 rounded-full border border-border bg-muted/40 px-3 py-1 text-sm"
                      >
                        <GithubMark size={13} />
                        {inst.accountLogin}
                        {inst.suspended && <span className="text-[10px] text-amber-300">suspended</span>}
                      </span>
                    ))
                  )}
                  <a
                    href="/auth/install"
                    className="text-sm text-primary underline decoration-dotted underline-offset-4 transition-colors hover:text-primary/80"
                  >
                    Install on another account
                  </a>
                </div>
              </section>

              {/* The gate */}
              <section className="rounded-xl border border-border/70 bg-card/40 p-5">
                <h2 className="text-sm font-semibold">Repositories</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  Only enabled repos trigger the agent — an{" "}
                  <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-primary">agent:fix</span>{" "}
                  label anywhere else is recorded and ignored.
                </p>

                {data.installations.length === 0 ? (
                  <div className="mt-4 rounded-lg border border-border bg-muted/20 px-4 py-4 text-sm text-muted-foreground">
                    Nothing to choose yet — install the app first.
                  </div>
                ) : (
                  <RepoPicker data={data} onSaved={load} />
                )}

                <p className="mt-5 text-[11px] leading-relaxed text-muted-foreground/80">
                  Disabling a repo stops new events from becoming work; threads already in flight keep their history and
                  can be watched to completion.
                </p>
              </section>
            </>
          )}
        </div>
      </div>
    </AppShell>
  );
}
