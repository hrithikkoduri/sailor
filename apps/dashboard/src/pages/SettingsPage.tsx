/**
 * Settings — the gate's control surface, in the product-suite chrome.
 * Repositories you enable here are the only ones whose events become work.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { GitBranch } from "lucide-react";
import { api, ApiError, type OnboardingData } from "@/api";
import { AppShell } from "@/components/app-shell";
import { GithubMark } from "@/components/brand";
import { Switch } from "@/components/animate-ui/components/radix/switch";

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

  const isDirty = useMemo(() => {
    if (!data) return false;
    return data.installations.some((inst) => {
      const now = selected[inst.installationId] ?? new Set<string>();
      const savedSet = new Set(inst.repos.filter((r) => r.enabled).map((r) => r.fullName));
      return now.size !== savedSet.size || [...now].some((name) => !savedSet.has(name));
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

              {/* Repositories */}
              <section className="rounded-xl border border-border/70 bg-card/40 p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h2 className="text-sm font-semibold">Repositories</h2>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Only enabled repos trigger the agent — an{" "}
                      <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-primary">agent:fix</span>{" "}
                      label anywhere else is recorded and ignored.
                    </p>
                  </div>
                  <div className="flex items-center gap-3">
                    {saved && !isDirty && <span className="text-xs text-primary">Saved ✓</span>}
                    <button
                      onClick={save}
                      disabled={saving || !isDirty}
                      className="cursor-pointer rounded-lg bg-primary px-3.5 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {saving ? "Saving…" : "Save changes"}
                    </button>
                  </div>
                </div>

                {data.installations.length === 0 ? (
                  <div className="mt-4 rounded-lg border border-border bg-muted/20 px-4 py-4 text-sm text-muted-foreground">
                    Nothing to choose yet — install the app first.
                  </div>
                ) : (
                  data.installations.map((inst) => (
                    <div key={inst.installationId} className="mt-5">
                      <div className="flex items-center justify-between">
                        <h3 className="flex items-center gap-2 font-mono text-[11px] tracking-widest text-muted-foreground uppercase">
                          <GitBranch className="size-3.5" />
                          {inst.accountLogin}
                        </h3>
                        <span className="font-mono text-[10.5px] text-muted-foreground">
                          {(selected[inst.installationId]?.size ?? 0)}/{inst.repos.length} enabled
                        </span>
                      </div>
                      <div className="mt-2.5 space-y-1.5">
                        {inst.repos.length === 0 && (
                          <p className="text-sm text-muted-foreground">No repositories visible to this installation.</p>
                        )}
                        {inst.repos.map((repo) => {
                          const on = selected[inst.installationId]?.has(repo.fullName) ?? false;
                          return (
                            <div
                              key={repo.fullName}
                              role="button"
                              tabIndex={0}
                              onClick={() => toggle(inst.installationId, repo.fullName)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter" || e.key === " ") {
                                  e.preventDefault();
                                  toggle(inst.installationId, repo.fullName);
                                }
                              }}
                              className={`flex cursor-pointer items-center justify-between rounded-lg border px-3.5 py-2.5 transition-colors duration-200 ${
                                on
                                  ? "border-primary/40 bg-primary/10"
                                  : "border-border/70 bg-muted/20 hover:bg-muted/40"
                              }`}
                            >
                              <span className="min-w-0">
                                <span className="block truncate text-sm font-medium">{repo.fullName}</span>
                                <span className="font-mono text-[10.5px] text-muted-foreground">
                                  {repo.defaultBranch ?? "—"}
                                </span>
                              </span>
                              <Switch
                                checked={on}
                                onCheckedChange={() => toggle(inst.installationId, repo.fullName)}
                                onClick={(e) => e.stopPropagation()}
                              />
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ))
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
