import { useEffect, useMemo, useState } from "react";
import { Check, GitBranch, Loader2, Search, RefreshCw } from "lucide-react";
import { saveRepos, type GateData } from "../api";
import { Switch } from "@/components/animate-ui/components/radix/switch";
import { Input } from "@/components/ui/input";
import { Button } from "@/elements/button";

const selectionFrom = (data: GateData) =>
  Object.fromEntries(
    data.installations.map((inst) => [
      inst.installationId,
      new Set(inst.repos.filter((r) => r.enabled).map((r) => r.fullName)),
    ]),
  );

/** One repository control surface for settings and onboarding. */
export function RepoPicker({
  data,
  onSaved,
  onRefresh,
  saveLabel,
  requireSelection = false,
}: {
  data: GateData;
  onSaved?: () => void | Promise<void>;
  onRefresh?: () => Promise<void>;
  saveLabel?: string | ((count: number) => string);
  requireSelection?: boolean;
}) {
  const [selected, setSelected] = useState<Record<number, Set<string>>>(() =>
    selectionFrom(data),
  );
  const [query, setQuery] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [refreshed, setRefreshed] = useState(false);
  useEffect(() => {
    setSelected(selectionFrom(data));
  }, [data]);
  const enabled = Object.values(selected).reduce(
    (sum, repos) => sum + repos.size,
    0,
  );
  const dirty = useMemo(
    () =>
      data.installations.some((inst) =>
        inst.repos.some(
          (repo) =>
            repo.enabled !==
            (selected[inst.installationId]?.has(repo.fullName) ?? false),
        ),
      ),
    [data, selected],
  );
  const toggle = (id: number, name: string) => {
    setSaved(false);
    setSelected((prev) => {
      const next = new Set(prev[id]);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return { ...prev, [id]: next };
    });
  };
  const save = async () => {
    setSaving(true);
    setError("");
    try {
      for (const inst of data.installations)
        await saveRepos(inst.installationId, [
          ...(selected[inst.installationId] ?? []),
        ]);
      await onSaved?.();
      setSaved(true);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Changes could not be saved. Please retry.",
      );
    } finally {
      setSaving(false);
    }
  };
  const refresh = async () => {
    if (!onRefresh || dirty || saving || refreshing) return;
    setRefreshing(true); setRefreshed(false); setError("");
    try { await onRefresh(); setRefreshed(true); }
    catch (err) { setError(err instanceof Error ? err.message : "Could not refresh repositories. Try again."); }
    finally { setRefreshing(false); }
  };
  return (
    <div>
      <div className="mb-5 flex flex-wrap items-center gap-3">
      <div className="relative min-w-48 flex-1">
        <Search className="pointer-events-none absolute top-3 left-3 size-3.5 text-muted-foreground" />
        <Input
          aria-label="Search repositories"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Find a repository…"
          className="h-10 rounded-lg bg-background pl-9 text-xs shadow-none"
        />
      </div>
      {onRefresh && <Button variant="outline" size="sm" className="h-10" onClick={() => void refresh()}
        disabled={dirty || saving || refreshing} title={dirty ? "Save or discard your changes before refreshing" : undefined}>
        <RefreshCw className={`size-3.5 ${refreshing ? "animate-spin" : ""}`} />{refreshing ? "Refreshing…" : "Refresh from GitHub"}
      </Button>}
      </div>
      {onRefresh && dirty && <p className="mb-4 text-xs text-muted-foreground">Save or discard your changes before refreshing.</p>}
      {refreshed && <p role="status" className="mb-4 text-xs text-muted-foreground">Repository list refreshed. Existing choices were kept; new repositories start disabled.</p>}
      {data.installations.map((inst) => (
        <section key={inst.installationId} className="mb-5">
          <div className="mb-3 flex items-center justify-between text-xs text-muted-foreground">
            <span className="font-medium">
              {inst.accountLogin}
              {inst.suspended ? " · Suspended" : ""}
            </span>
            <span>
              {selected[inst.installationId]?.size ?? 0} of {inst.repos.length}{" "}
              enabled
            </span>
          </div>
          <div className="overflow-hidden rounded-xl border border-border">
            {inst.repos
              .filter((repo) =>
                repo.fullName.toLowerCase().includes(query.toLowerCase()),
              )
              .map((repo) => {
                const on =
                  selected[inst.installationId]?.has(repo.fullName) ?? false;
                const controlId = `repo-${inst.installationId}-${repo.fullName.replace(/[^a-zA-Z0-9-]/g, "-")}`;
                return (
                  <div
                    key={repo.fullName}
                    className="flex items-center gap-3 border-b border-border bg-card px-4 py-4 last:border-0 hover:bg-muted/20"
                  >
                    <GitBranch className="size-4 shrink-0 text-muted-foreground" />
                    <label
                      htmlFor={controlId}
                      className="min-w-0 flex-1 cursor-pointer"
                    >
                      <span className="block truncate text-[13px] font-medium">
                        {repo.fullName}
                      </span>
                      <span className="mt-1 block text-[11px] text-muted-foreground">
                        {repo.defaultBranch ?? "Default branch"}
                      </span>
                    </label>
                    <Switch
                      id={controlId}
                      aria-label={`Enable ${repo.fullName}`}
                      checked={on}
                      disabled={saving || refreshing || inst.suspended}
                      onCheckedChange={() =>
                        toggle(inst.installationId, repo.fullName)
                      }
                    />
                  </div>
                );
              })}
            {!inst.repos.some((repo) =>
              repo.fullName.toLowerCase().includes(query.toLowerCase()),
            ) && (
              <p className="p-5 text-sm text-muted-foreground">
                No repositories match your search.
              </p>
            )}
          </div>
        </section>
      ))}
      {error && (
        <p role="alert" className="mb-4 text-xs text-destructive">
          {error}
        </p>
      )}
      <div className="flex items-center justify-between gap-3 border-t border-border pt-5">
        <p className="text-xs text-muted-foreground" aria-live="polite">
          {saved && !dirty ? (
            <span className="flex items-center gap-1.5">
              <Check className="size-3.5" />
              Changes saved
            </span>
          ) : dirty ? (
            "You have unsaved changes"
          ) : (
            `${enabled} repositories enabled`
          )}
        </p>
        <div className="flex gap-2">
          {dirty && (
            <Button
              variant="ghost"
              size="sm"
              disabled={saving}
              onClick={() => {
                setSelected(selectionFrom(data));
                setSaved(false);
              }}
            >
              Discard
            </Button>
          )}
          <Button
            size="sm"
              disabled={saving || refreshing || !dirty || (requireSelection && enabled === 0)}
            onClick={() => void save()}
          >
            {saving && <Loader2 className="size-3.5 animate-spin" />}
            {saving
              ? "Saving…"
              : typeof saveLabel === "function"
                ? saveLabel(enabled)
                : (saveLabel ?? "Save changes")}
          </Button>
        </div>
      </div>
    </div>
  );
}
