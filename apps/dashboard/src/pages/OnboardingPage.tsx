import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, ApiError, type OnboardingData } from "../api";
import { GithubMark, Logo, Wordmark } from "../components/brand";
import { Toggle } from "../components/Toggle";

function Step({ n, label, active, done }: { n: number; label: string; active: boolean; done: boolean }) {
  return (
    <div className="flex items-center gap-2.5">
      <span
        className={`flex h-7 w-7 items-center justify-center rounded-full border text-xs font-semibold transition ${
          done
            ? "border-primary/50 bg-primary/20 text-primary"
            : active
              ? "border-primary/50 bg-primary text-primary-foreground"
              : "border-white/15 bg-card/40 text-muted-foreground"
        }`}
      >
        {done ? "✓" : n}
      </span>
      <span className={`text-sm ${active || done ? "text-slate-200" : "text-muted-foreground"}`}>{label}</span>
    </div>
  );
}

export function OnboardingPage() {
  const navigate = useNavigate();
  const [data, setData] = useState<OnboardingData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Record<number, Set<string>>>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const load = () =>
    api<OnboardingData>("/api/onboarding")
      .then((d) => {
        setData(d);
        const init: Record<number, Set<string>> = {};
        for (const inst of d.installations) {
          init[inst.installationId] = new Set(inst.repos.filter((r) => r.enabled).map((r) => r.fullName));
        }
        setSelected(init);
      })
      .catch((err: unknown) => {
        if (err instanceof ApiError && err.status === 401) navigate("/login");
        else setError("Could not load onboarding state.");
      });

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const enabledCount = useMemo(
    () => Object.values(selected).reduce((n, s) => n + s.size, 0),
    [selected],
  );
  const hasInstall = (data?.installations.length ?? 0) > 0;
  const stepNo: 1 | 2 | 3 = !hasInstall ? 1 : saved ? 3 : 2;

  const toggle = (installationId: number, fullName: string) => {
    setSelected((prev) => {
      const set = new Set(prev[installationId] ?? []);
      if (set.has(fullName)) set.delete(fullName);
      else set.add(fullName);
      return { ...prev, [installationId]: set };
    });
  };

  const save = async () => {
    if (!data) return;
    setSaving(true);
    setError(null);
    try {
      for (const inst of data.installations) {
        await api("/api/onboarding/repos", {
          method: "POST",
          body: JSON.stringify({
            installationId: inst.installationId,
            enabled: [...(selected[inst.installationId] ?? [])],
          }),
        });
      }
      setSaved(true);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save your selection.");
    } finally {
      setSaving(false);
    }
  };

  const logout = async () => {
    await api("/auth/logout", { method: "POST" }).catch(() => undefined);
    navigate("/login");
  };

  return (
    <div className="bg-ambient min-h-dvh">
      <header className="mx-auto flex max-w-3xl items-center justify-between px-6 py-6">
        <Wordmark />
        <div className="flex items-center gap-3">
          {data?.user && (
            <span className="flex items-center gap-2 rounded-full border border-border bg-card/40 py-1 pl-1 pr-3 text-sm text-slate-300">
              {data.user.avatarUrl ? (
                <img src={data.user.avatarUrl} alt="" className="h-6 w-6 rounded-full" />
              ) : (
                <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary/20 text-[10px] font-semibold uppercase">
                  {(data.user.name ?? data.user.email ?? "?").slice(0, 1)}
                </span>
              )}
              {data.user.name ?? data.user.login ?? data.user.email}
            </span>
          )}
          <button onClick={logout} className="text-sm text-muted-foreground transition hover:text-slate-200">
            Sign out
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-6 pb-20">
        <div className="flex flex-wrap items-center gap-x-8 gap-y-3">
          <Step n={1} label="Connect GitHub" active={stepNo === 1} done={stepNo > 1} />
          <Step n={2} label="Choose repos" active={stepNo === 2} done={stepNo > 2} />
          <Step n={3} label="You're set" active={stepNo === 3} done={false} />
        </div>

        {error && (
          <div className="mt-6 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
            {error}
          </div>
        )}

        {/* --- step 1: install the App --------------------------------------- */}
        {stepNo === 1 && data && (
          <div className="mt-10 rounded-2xl border border-border bg-card/40 p-8 shadow-2xl shadow-black/40">
            <div className="flex items-start gap-4">
              <Logo size={44} />
              <div>
                <h1 className="text-xl font-semibold tracking-tight">Install the Harness app</h1>
                <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
                  Harness works inside your repositories through a GitHub App — it reads issues, pushes
                  branches, and opens pull requests as its own bot identity. You choose the repos; nothing
                  else is ever touched.
                </p>
              </div>
            </div>

            {!data.githubAppConfigured && (
              <div className="mt-6 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
                The server has no GitHub App configured yet (set <code className="font-mono">GITHUB_APP_*</code> in{" "}
                <code className="font-mono">.env</code>). You can still look around — the install button will start
                working once the app exists.
              </div>
            )}

            <div className="mt-8">
              <a
                href="/auth/install"
                className="inline-flex items-center gap-2.5 rounded-lg bg-primary px-5 py-3 text-sm font-medium text-primary-foreground transition hover:bg-primary/90"
              >
                <GithubMark /> Install on GitHub
              </a>
              <p className="mt-4 text-xs text-muted-foreground">
                GitHub will ask which repositories to grant — pick the ones you want the agent to work on.
              </p>
            </div>
          </div>
        )}

        {/* --- step 2: choose the repos (THE GATE) ---------------------------- */}
        {stepNo === 2 && data && (
          <div className="mt-10 space-y-6">
            <div className="rounded-2xl border border-border bg-card/40 p-8 shadow-2xl shadow-black/40">
              <h1 className="text-xl font-semibold tracking-tight">Choose your repos</h1>
              <p className="mt-1.5 text-sm text-muted-foreground">
                Only the repos you enable here can trigger the agent — an issue labeled{" "}
                <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">agent:fix</span> anywhere
                else is ignored.
              </p>

              {data.installations.map((inst) => (
                <div key={inst.installationId} className="mt-7">
                  <div className="flex items-center justify-between">
                    <h2 className="text-sm font-semibold text-slate-200">
                      {inst.accountLogin}
                      <span className="ml-2 rounded-full border border-border px-2 py-0.5 text-[10px] font-normal uppercase tracking-wide text-muted-foreground">
                        {inst.suspended ? "suspended" : "installed"}
                      </span>
                    </h2>
                    <span className="text-xs text-muted-foreground">
                      {(selected[inst.installationId]?.size ?? 0)} of {inst.repos.length} enabled
                    </span>
                  </div>
                  <div className="mt-3 space-y-2">
                    {inst.repos.map((repo) => {
                      const on = selected[inst.installationId]?.has(repo.fullName) ?? false;
                      return (
                        <button
                          key={repo.fullName}
                          type="button"
                          onClick={() => toggle(inst.installationId, repo.fullName)}
                          className={`flex w-full items-center justify-between rounded-xl border px-4 py-3 text-left transition ${
                            on
                              ? "border-primary/40 bg-primary/10"
                              : "border-border bg-white/[0.02] hover:bg-white/[0.05]"
                          }`}
                        >
                          <span>
                            <span className="text-sm font-medium text-foreground">{repo.fullName}</span>
                            <span className="ml-2 text-xs text-muted-foreground">{repo.defaultBranch}</span>
                          </span>
                          <Toggle on={on} />
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}

              <div className="mt-8 flex items-center justify-between">
                <a href="/auth/install" className="text-sm text-muted-foreground transition hover:text-slate-200">
                  + Install on another account
                </a>
                <button
                  onClick={save}
                  disabled={saving || enabledCount === 0}
                  className="rounded-lg bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground transition hover:bg-primary/90 disabled:opacity-40"
                >
                  {saving ? "Saving…" : enabledCount === 0 ? "Select at least one repo" : `Enable ${enabledCount} repo${enabledCount === 1 ? "" : "s"}`}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* --- step 3: done ---------------------------------------------------- */}
        {stepNo === 3 && (
          <div className="mt-10 rounded-2xl border border-border bg-card/40 p-8 shadow-2xl shadow-black/40">
            <div className="flex h-12 w-12 items-center justify-center rounded-full border border-primary/50 bg-primary/20 text-xl">
              ✓
            </div>
            <h1 className="mt-5 text-xl font-semibold tracking-tight">You're set.</h1>
            <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
              Create an issue in one of your enabled repositories and label it:
            </p>
            <div className="mt-4 inline-flex items-center gap-2 rounded-lg border border-border bg-[#0b1322] px-4 py-2.5 font-mono text-sm text-primary">
              agent:fix
            </div>
            <p className="mt-4 text-sm leading-relaxed text-muted-foreground">
              The agent picks it up, fixes it in an isolated microVM, verifies with tests, and opens a pull
              request with a full trace. Every move is checked against real evidence — and the moment a check
              can't be satisfied, you'll hear about it.
            </p>
            <button
              onClick={() => navigate("/")}
              className="mt-7 rounded-lg bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground transition hover:bg-primary/90"
            >
              Open the dashboard
            </button>
          </div>
        )}
      </main>
    </div>
  );
}
