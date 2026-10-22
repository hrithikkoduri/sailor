import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { FolderGit2, Loader2, Repeat } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/animate-ui/components/radix/dialog";
import { Button } from "@/elements/button";
import { getGate } from "@/features/repos/api";
import { enabledRepositoryNames } from "@/features/repos/enabled";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/elements/select";
import {
  attachThreadRepository,
  repositoryLabel,
  switchThreadRepository,
  type ThreadSummary,
} from "../api";

/** Attach (workspace thread) or switch (thread already has a repository). */
export function ThreadRepositoryControl({ thread, active, blocked, queued, repository, additional = [], onAttached }: {
  thread: ThreadSummary; active: boolean; blocked: boolean; queued: boolean; onAttached: () => void;
  /** The repository the thread is actually working in — including one the agent
   * attached during a run, before the thread row is refetched. */
  repository?: string;
  /** Sibling repositories the agent cloned outside the thread's workspace. */
  additional?: string[];
}) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"attach" | "switch">("attach");
  const [repos, setRepos] = useState<string[]>([]);
  const [repo, setRepo] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setError("");
    getGate().then((data) => { if (alive) setRepos(enabledRepositoryNames(data.installations)); })
      .catch(() => { if (alive) setError("Couldn't load repositories. Check Settings and try again."); });
    return () => { alive = false; };
  }, [open]);

  const shown = repository ?? (thread.source !== "workspace" ? thread.repo : undefined);
  const extras = additional.filter((r) => r !== shown);
  const start = (next: "attach" | "switch") => { setMode(next); setRepo(""); setOpen(true); };

  const submit = async () => {
    if (!repo || busy) return;
    setBusy(true);
    setError("");
    try {
      if (mode === "switch") await switchThreadRepository(thread.id, repo);
      else await attachThreadRepository(thread.id, repo);
      setSubmitted(true);
      setOpen(false);
      onAttached();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't update the repository.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <span className="flex min-w-0 items-center gap-1.5 px-1 text-xs text-muted-foreground">
      {shown ? (
        <span className="flex min-w-0 items-center gap-1.5" title={shown}>
          {queued ? <Loader2 className="size-3.5 shrink-0 animate-spin" /> : <FolderGit2 className="size-3.5 shrink-0" />}
          <span className="max-w-52 truncate">{repositoryLabel(shown)}</span>
        </span>
      ) : (
        <Button type="button" size="sm" variant="ghost" className="h-8 gap-1.5 text-xs text-muted-foreground"
          disabled={blocked || queued || submitted}
          title={blocked ? "Answer the pending questions first" : undefined}
          onClick={() => start("attach")}>
          <FolderGit2 className="size-3.5" />
          {queued || submitted ? "Repository attachment queued" : "Attach repository"}
        </Button>
      )}
      {extras.map((extra) => (
        <span
          key={extra}
          title={`The agent also checked out ${extra} — outside this thread's repository`}
          className="flex min-w-0 items-center gap-1 rounded-md border border-warning/40 bg-warning/10 px-1.5 py-0.5 text-[11px]"
        >
          <span className="shrink-0 text-muted-foreground">+</span>
          <span className="max-w-40 truncate">{repositoryLabel(extra)}</span>
        </span>
      ))}
      {shown && (
        <Button type="button" size="sm" variant="ghost" className="h-7 gap-1 px-1.5 text-[11px] text-muted-foreground"
          disabled={blocked || queued || submitted || active}
          title={active ? "Wait for the current run to finish" : "Work in a different repository"}
          onClick={() => start("switch")}>
          <Repeat className="size-3" />
          Change
        </Button>
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="rounded-2xl">
          <DialogHeader>
            <DialogTitle>{mode === "switch" ? "Change repository" : "Attach a repository"}</DialogTitle>
            <DialogDescription>
              {mode === "switch"
                ? `Keeps this conversation, but starts a fresh workspace in the new repository. Branch and PR links reset, and the current sandbox is released. Work already pushed to ${repositoryLabel(shown ?? "")} stays there.`
                : "Sailor will check out the repository before continuing this thread. Existing repositories and workspace files will never be overwritten."}
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={(event) => { event.preventDefault(); void submit(); }} className="space-y-4">
            <label className="block text-sm font-medium" htmlFor="thread-repository">Repository</label>
            <Select required value={repo} onValueChange={setRepo} disabled={busy}>
              <SelectTrigger id="thread-repository" className="h-11 text-sm">
                <SelectValue placeholder="Choose an enabled repository…" />
              </SelectTrigger>
              <SelectContent>
                {repos.map((name) => <SelectItem key={name} value={name}>{name}</SelectItem>)}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">Missing a repository? <Link to="/settings" className="underline underline-offset-4">Enable it in Settings</Link>.</p>
            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
            <div className="flex justify-end">
              <Button type="submit" disabled={busy || !repo}>
                {busy && <Loader2 className="size-4 animate-spin" />}
                {mode === "switch" ? "Switch and continue" : active ? "Queue attachment" : "Attach and continue"}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </span>
  );
}
