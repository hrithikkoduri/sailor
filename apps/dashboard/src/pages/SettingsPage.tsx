/**
 * SettingsPage — the gate's control surface.
 *
 * Which repos may trigger the agent (the `repositories.enabled` flags behind
 * every webhook check), plus where you stand with GitHub. Selection here is
 * the same switch onboarding sets — you can flip it any time, and disabling a
 * repo stops NEW events from becoming work (existing threads keep running).
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, ApiError, type OnboardingData } from "../api";
import { Shell } from "../components/Shell";
import { Toggle } from "../components/Toggle";
import { GithubMark } from "../components/brand";

export function SettingsPage() {
  const navigate = useNavigate();
  const [data, setData] = useState<OnboardingData | null>(null);
  const [selected, setSelected] = useState<Record<number, Set<string>>>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await api<OnboardingData>("/api/onboarding");
      setData(d);
      const init: Record<number, Set<string>> = {};
      for (const inst of d.installations) {
        init[inst.installationId] = new Set(inst.repos.filter((r) => r.enabled).map((r) => r.fullName));
      }
      setSelected(init);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) navigate("/login");
      else setError("Could not load settings.");
    }
  }, [navigate]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Dirtiness = what's toggled now vs what the server last told us. */
  const isDirty = useMemo(() => {
    if (!data) return false;
    return data.installations.some((inst) => {
      const now = selected[inst.installationId] ?? new Set<string>();
      const saved = new Set(inst.repos.filter((r) => r.enabled).map((r) => r.fullName));
      return now.size !== saved.size || [...now].some((name) => !saved.has(name));
    });
  }, [data, selected]);

  const toggle = (installationId: number, fullName: string) => {
    setSaved(false);
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
      await load();
      setSaved(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save changes.");
    } finally {
      setSaving(false);
    }
  };

  const enabledCount = (id: number) => selected[id]?.size ?? 0;

  return (
    <Shell>
      <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
      <p className="mt-1 text-sm text-zinc-400">What the agent may work on, and how it gets access.</p>

      {error && (
        <div className="mt-6 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-2.5 text-sm text-red-300">
          {error}
        </div>
      )}

      {data === null ? (
        <p className="mt-10 text-sm text-zinc-500">Loading…</p>
      ) : (
        <>
          {/* GitHub connection */}
          <section className="mt-8 rounded-2xl border border-white/10 bg-white/[0.03] p-6">
            <h2 className="text-sm font-semibold text-zinc-200">GitHub</h2>
            {!data.githubAppConfigured && (
              <div className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
                The server has no GitHub App configured (set <code className="font-mono">GITHUB_APP_*</code> in{" "}
                <code className="font-mono">.env</code>).
              </div>
            )}
            {data.installations.length === 0 ? (
              <p className="mt-2 text-sm text-zinc-400">
                No installation yet — connect GitHub to give the agent a way in.
              </p>
            ) : (
              <div className="mt-3 flex flex-wrap gap-2">
                {data.installations.map((inst) => (
                  <span
                    key={inst.installationId}
                    className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-sm text-zinc-300"
                  >
                    {inst.accountLogin}
                    {inst.suspended && <span className="ml-2 text-xs text-amber-300">suspended</span>}
                  </span>
                ))}
              </div>
            )}
            <a
              href="/auth/install"
              className="mt-4 inline-flex items-center gap-2 text-sm text-indigo-300 transition hover:text-indigo-200"
            >
              <GithubMark size={14} /> Install on another account
            </a>
          </section>

          {/* The gate */}
          <section className="mt-6 rounded-2xl border border-white/10 bg-white/[0.03] p-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold text-zinc-200">Repositories</h2>
                <p className="mt-1 text-sm text-zinc-400">
                  Only enabled repos trigger the agent — an{" "}
                  <span className="rounded bg-white/10 px-1.5 py-0.5 font-mono text-xs">agent:fix</span> label anywhere
                  else is recorded and ignored.
                </p>
              </div>
              <div className="flex items-center gap-3">
                {saved && !isDirty && <span className="text-sm text-emerald-300">Saved ✓</span>}
                <button
                  onClick={save}
                  disabled={saving || !isDirty}
                  className="rounded-lg bg-indigo-500 px-4 py-2 text-sm font-medium text-white transition hover:bg-indigo-400 disabled:opacity-40"
                >
                  {saving ? "Saving…" : "Save changes"}
                </button>
              </div>
            </div>

            {data.installations.length === 0 ? (
              <div className="mt-5 rounded-xl border border-white/10 bg-white/[0.02] px-4 py-5 text-sm text-zinc-400">
                Nothing to choose yet — install the app first.
                <a href="/auth/install" className="ml-2 text-indigo-300 hover:text-indigo-200">
                  Install on GitHub →
                </a>
              </div>
            ) : (
              data.installations.map((inst) => (
                <div key={inst.installationId} className="mt-6">
                  <div className="flex items-center justify-between">
                    <h3 className="text-xs font-semibold tracking-widest text-zinc-400 uppercase">
                      {inst.accountLogin}
                    </h3>
                    <span className="text-xs text-zinc-500">
                      {enabledCount(inst.installationId)} of {inst.repos.length} enabled
                    </span>
                  </div>
                  <div className="mt-3 space-y-2">
                    {inst.repos.length === 0 && (
                      <p className="text-sm text-zinc-500">No repositories visible to this installation.</p>
                    )}
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
              ))
            )}

            <p className="mt-6 text-xs text-zinc-600">
              Disabling a repo stops new events from becoming work; threads already in flight keep their history and
              can be watched to completion.
            </p>
          </section>
        </>
      )}
    </Shell>
  );
}
