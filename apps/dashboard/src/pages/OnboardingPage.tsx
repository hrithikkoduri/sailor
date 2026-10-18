import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, ApiError, type OnboardingData } from "../api";
import { GithubMark, Logo, Wordmark } from "../components/brand";

function Toggle({ on }: { on: boolean }) {
  return (
    <span
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${
        on ? "bg-indigo-500" : "bg-white/15"
      }`}
    >
      <span
        className={`inline-block h-4.5 w-4.5 transform rounded-full bg-white shadow transition-transform ${
          on ? "translate-x-5.5" : "translate-x-1"
        }`}
      />
    </span>
  );
}

function Step({ n, label, active, done }: { n: number; label: string; active: boolean; done: boolean }) {
  return (
    <div className="flex items-center gap-2.5">
      <span
        className={`flex h-7 w-7 items-center justify-center rounded-full border text-xs font-semibold transition ${
          done
            ? "border-indigo-400/60 bg-indigo-500/20 text-indigo-200"
            : active
              ? "border-indigo-400/60 bg-indigo-500 text-white"
              : "border-white/15 bg-white/[0.03] text-zinc-500"
        }`}
      >
        {done ? "✓" : n}
      </span>
      <span className={`text-sm ${active || done ? "text-zinc-200" : "text-zinc-500"}`}>{label}</span>
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
    <div className="bg-aura min-h-dvh">
      <header className="mx-auto flex max-w-3xl items-center justify-between px-6 py-6">
        <Wordmark />
        <div className="flex items-center gap-3">
          {data?.user && (
            <span className="flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] py-1 pl-1 pr-3 text-sm text-zinc-300">
              {data.user.avatarUrl ? (
                <img src={data.user.avatarUrl} alt="" className="h-6 w-6 rounded-full" />
              ) : (
                <span className="flex h-6 w-6 items-center justify-center rounded-full bg-indigo-500/30 text-[10px] font-semibold uppercase">
                  {(data.user.name ?? data.user.email ?? "?").slice(0, 1)}
                </span>
              )}
              {data.user.name ?? data.user.login ?? data.user.email}
            </span>
          )}
          <button onClick={logout} className="text-sm text-zinc-400 transition hover:text-zinc-200">
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
          <div className="mt-10 rounded-2xl border border-white/10 bg-white/[0.03] p-8 shadow-2xl shadow-black/40">
            <div className="flex items-start gap-4">
              <Logo size={44} />
              <div>
                <h1 className="text-xl font-semibold tracking-tight">Install the Harness app</h1>
                <p className="mt-1.5 text-sm leading-relaxed text-zinc-400">
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
                className="inline-flex items-center gap-2.5 rounded-lg bg-indigo-500 px-5 py-3 text-sm font-medium text-white transition hover:bg-indigo-400"
              >
                <GithubMark /> Install on GitHub
              </a>
              <p className="mt-4 text-xs text-zinc-500">
                GitHub will ask which repositories to grant — pick the ones you want the agent to work on.
              </p>
            </div>
          </div>
        )}

        {/* --- step 2: choose the repos (THE GATE) ---------------------------- */}
        {stepNo === 2 && data && (
          <div className="mt-10 space-y-6">
            <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-8 shadow-2xl shadow-black/40">
              <h1 className="text-xl font-semibold tracking-tight">Choose your repos</h1>
              <p className="mt-1.5 text-sm text-zinc-400">
                Only the repos you enable here can trigger the agent — an issue labeled{" "}
                <span className="rounded bg-white/10 px-1.5 py-0.5 font-mono text-xs">agent:fix</span> anywhere
                else is ignored.
              </p>

              {data.installations.map((inst) => (
                <div key={inst.installationId} className="mt-7">
                  <div className="flex items-center justify-between">
                    <h2 className="text-sm font-semibold text-zinc-200">
                      {inst.accountLogin}
                      <span className="ml-2 rounded-full border border-white/10 px-2 py-0.5 text-[10px] font-normal uppercase tracking-wide text-zinc-400">
                        {inst.suspended ? "suspended" : "installed"}
                      </span>
                    </h2>
                    <span className="text-xs text-zinc-500">
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
                              ? "border-indigo-400/40 bg-indigo-500/[0.08]"
                              : "border-white/10 bg-white/[0.02] hover:bg-white/[0.05]"
                          }`}
                        >
                          <span>
                            <span className="text-sm font-medium text-zinc-100">{repo.fullName}</span>
                            <span className="ml-2 text-xs text-zinc-500">{repo.defaultBranch}</span>
                          </span>
                          <Toggle on={on} />
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}

              <div className="mt-8 flex items-center justify-between">
                <a href="/auth/install" className="text-sm text-zinc-400 transition hover:text-zinc-200">
                  + Install on another account
                </a>
                <button
                  onClick={save}
                  disabled={saving || enabledCount === 0}
                  className="rounded-lg bg-indigo-500 px-5 py-2.5 text-sm font-medium text-white transition hover:bg-indigo-400 disabled:opacity-40"
                >
                  {saving ? "Saving…" : enabledCount === 0 ? "Select at least one repo" : `Enable ${enabledCount} repo${enabledCount === 1 ? "" : "s"}`}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* --- step 3: done ---------------------------------------------------- */}
        {stepNo === 3 && (
          <div className="mt-10 rounded-2xl border border-white/10 bg-white/[0.03] p-8 shadow-2xl shadow-black/40">
            <div className="flex h-12 w-12 items-center justify-center rounded-full border border-indigo-400/50 bg-indigo-500/20 text-xl">
              ✓
            </div>
            <h1 className="mt-5 text-xl font-semibold tracking-tight">You're set.</h1>
            <p className="mt-1.5 text-sm leading-relaxed text-zinc-400">
              Create an issue in one of your enabled repositories and label it:
            </p>
            <div className="mt-4 inline-flex items-center gap-2 rounded-lg border border-white/10 bg-black/40 px-4 py-2.5 font-mono text-sm text-indigo-200">
              agent:fix
            </div>
            <p className="mt-4 text-sm leading-relaxed text-zinc-400">
              The agent picks it up, fixes it in an isolated microVM, verifies with tests, and opens a pull
              request with a full trace. Every move is checked against real evidence — and the moment a check
              can't be satisfied, you'll hear about it.
            </p>
            <button
              onClick={() => navigate("/")}
              className="mt-7 rounded-lg bg-indigo-500 px-5 py-2.5 text-sm font-medium text-white transition hover:bg-indigo-400"
            >
              Open the dashboard
            </button>
          </div>
        )}
      </main>
    </div>
  );
}
