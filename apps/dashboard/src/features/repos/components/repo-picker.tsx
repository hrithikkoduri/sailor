/**
 * RepoPicker — THE gate's control surface, shared by onboarding and settings.
 *
 * Owns the selection state, the dirty check, and the save loop; parents own
 * the surrounding card/step and react to `onSaved`. Both flows previously
 * had their own copy of this logic — one picker, one behavior.
 */
import { useEffect, useMemo, useState } from "react";
import { getGate, saveRepos, type GateData } from "@/features/repos/api";
import { Switch } from "@/components/animate-ui/components/radix/switch";
import { ApiError } from "@/utils/api-client";

const selectionFrom = (data: GateData): Record<number, Set<string>> => {
  const init: Record<number, Set<string>> = {};
  for (const inst of data.installations) {
    init[inst.installationId] = new Set(inst.repos.filter((r) => r.enabled).map((r) => r.fullName));
  }
  return init;
};

export function RepoPicker({
  data,
  onSaved,
  saveLabel,
}: {
  data: GateData;
  onSaved?: () => void;
  /** Static text, or a function of the selected count. Defaults to "Save changes". */
  saveLabel?: string | ((count: number) => string);
}) {
  const [selected, setSelected] = useState<Record<number, Set<string>>>(() => selectionFrom(data));
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Re-sync when the parent reloads the gate (fresh server truth wins).
  useEffect(() => {
    setSelected(selectionFrom(data));
  }, [data]);

  const enabledCount = useMemo(
    () => Object.values(selected).reduce((n, set) => n + set.size, 0),
    [selected],
  );

  const isDirty = useMemo(
    () =>
      data.installations.some((inst) => {
        const now = selected[inst.installationId] ?? new Set<string>();
        const current = new Set(inst.repos.filter((r) => r.enabled).map((r) => r.fullName));
        return now.size !== current.size || [...now].some((name) => !current.has(name));
      }),
    [data, selected],
  );

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
    setSaving(true);
    setError(null);
    try {
      for (const inst of data.installations) {
        await saveRepos(inst.installationId, [...(selected[inst.installationId] ?? [])]);
      }
      setSaved(true);
      onSaved?.();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save changes.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      {data.installations.map((inst) => (
        <div key={inst.installationId} className="mt-5">
          <div className="flex items-center justify-between">
            <h3 className="font-mono text-[11px] tracking-widest text-muted-foreground uppercase">
              {inst.accountLogin}
              {inst.suspended && <span className="ml-2 text-amber-300">suspended</span>}
            </h3>
            <span className="font-mono text-[10.5px] text-muted-foreground">
              {selected[inst.installationId]?.size ?? 0}/{inst.repos.length} enabled
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
                    on ? "border-primary/40 bg-primary/10" : "border-border/70 bg-muted/20 hover:bg-muted/40"
                  }`}
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">{repo.fullName}</span>
                    <span className="font-mono text-[10.5px] text-muted-foreground">{repo.defaultBranch ?? "—"}</span>
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
      ))}

      {error && (
        <div className="mt-4 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-red-300">
          {error}
        </div>
      )}

      <div className="mt-6 flex items-center justify-end gap-3">
        {saved && !isDirty && <span className="text-xs text-primary">Saved ✓</span>}
        <button
          onClick={() => void save()}
          disabled={saving || !isDirty || enabledCount === 0}
          className="cursor-pointer rounded-lg bg-primary px-3.5 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {saving ? "Saving…" : typeof saveLabel === "function" ? saveLabel(enabledCount) : (saveLabel ?? "Save changes")}
        </button>
      </div>
    </>
  );
}

/** Convenience for full-page loads (kept beside the picker so both flows share it). */
export const loadGate = getGate;
