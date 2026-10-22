import { useEffect, useState, type KeyboardEvent } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowUp, FolderGit2, Loader2 } from "lucide-react";
import { createThread } from "@/features/threads/api";
import { getGate } from "@/features/repos/api";
import { enabledRepositoryNames } from "@/features/repos/enabled";
import { Button } from "@/elements/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/elements/select";
import { ApiError } from "@/utils/api-client";
import { primaryModifier } from "@/utils/platform";
import { insertAtSelection } from "@/utils/text";

const NO_REPO = "__no_repository__";

export function NewThreadComposer() {
  const navigate = useNavigate();
  const [text, setText] = useState("");
  const [repo, setRepo] = useState("");
  const [repos, setRepos] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [repoError, setRepoError] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const newlineShortcut = `${primaryModifier()} + Enter`;
  useEffect(() => {
    let alive = true;
    getGate().then((data) => {
      if (alive) setRepos(enabledRepositoryNames(data.installations));
    }).catch((err) => {
      if (err instanceof ApiError && err.status === 401) navigate("/login");
      else if (alive) setRepoError("Repositories couldn't be loaded. You can still start without one.");
    }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [navigate]);
  const submit = async () => {
    if (busy || !text.trim()) return;
    setBusy(true); setError("");
    try { const data = await createThread(text.trim(), repo || undefined); navigate(`/threads/${data.thread.id}`); }
    catch (err) { setError(err instanceof Error ? err.message : "Couldn't start this thread. Your message is still here."); }
    finally { setBusy(false); }
  };
  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    if (event.metaKey || event.ctrlKey) {
      // Modified Enter does not consistently insert a newline across browsers.
      // Insert at the caret explicitly, replacing any selection.
      event.preventDefault();
      const textarea = event.currentTarget;
      const next = insertAtSelection(
        textarea.value,
        textarea.selectionStart,
        textarea.selectionEnd,
        "\n",
        8000,
      );
      if (!next) return;
      setText(next.value);
      requestAnimationFrame(() => textarea.setSelectionRange(next.caret, next.caret));
      return;
    }
    if (event.shiftKey || event.altKey) return;
    event.preventDefault();
    if (!event.repeat) void submit();
  };
  return <form onSubmit={(e) => { e.preventDefault(); void submit(); }} className="rounded-2xl border border-input bg-card shadow-[0_8px_40px_-24px_#0003] transition-shadow focus-within:ring-2 focus-within:ring-ring/15">
    <label htmlFor="new-thread-task" className="sr-only">What would you like to work on?</label>
    <textarea id="new-thread-task" rows={4} maxLength={8000} value={text} disabled={busy}
      placeholder="What would you like to work on?"
      onChange={(e) => setText(e.target.value)}
      onKeyDown={keyDown}
      aria-describedby="new-thread-keyboard"
      className="block min-h-36 w-full resize-y rounded-t-2xl bg-transparent p-5 text-base leading-relaxed outline-none placeholder:text-muted-foreground focus-visible:outline-none md:p-6" />
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-4 py-3 md:px-5">
      <div className="flex min-w-0 items-center gap-2"><FolderGit2 aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <Select
          value={repo || NO_REPO}
          onValueChange={(value) => setRepo(value === NO_REPO ? "" : value)}
          disabled={busy || loading}
        >
          <SelectTrigger id="new-thread-repo" aria-label="Repository (optional)" className="max-w-64">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NO_REPO}>{loading ? "Loading repositories…" : "No repository attached"}</SelectItem>
            {repos.map((name) => <SelectItem key={name} value={name}>{name}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
      <Button type="submit" disabled={busy || !text.trim()} className="h-10 rounded-lg">
        {busy ? <Loader2 className="size-4 animate-spin" /> : <ArrowUp className="size-4" />} {busy ? "Starting…" : "Start thread"}
      </Button>
    </div>
    <p className="px-5 pb-4 text-xs leading-relaxed text-muted-foreground">Attach a repo to start there. Otherwise Sailor can ask which one to use, or work in a fresh sandbox.</p>
    <p id="new-thread-keyboard" className="px-5 pb-4 text-xs text-muted-foreground">Enter to start · {newlineShortcut} for a new line</p>
    {repoError && <p role="status" className="px-5 pb-4 text-xs text-warning">{repoError}</p>}
    {error && <p role="alert" className="px-5 pb-4 text-sm text-destructive">{error}</p>}
  </form>;
}
