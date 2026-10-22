import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { Check, Layers, Loader2, MessageSquare, Pencil, Plus, Search, X } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/animate-ui/components/radix/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/elements/button";
import { IconButton } from "@/elements/icon-button";
import { getThreads, renameThread, threadTitle, repositoryLabel, type ThreadListItem } from "@/features/threads/api";
import { cn } from "@/utils/cn";
import { primaryModifier } from "@/utils/platform";
import { motion, useReducedMotion } from "motion/react";
import { Highlight, HighlightItem } from "@/components/animate-ui/primitives/effects/highlight";
import { controlSpring } from "@/utils/motion";
import { useThreadTabs } from "./thread-tabs-provider";

export function ThreadDock() {
  const reduce = useReducedMotion();
  const { tabs, draftIds, closeTab, updateTabs, applyTitle } = useThreadTabs();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const currentId = /^\/threads\/([^/]+)$/.exec(pathname)?.[1];
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [threads, setThreads] = useState<ThreadListItem[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState(0);
  const [editing, setEditing] = useState<string | null>(null);
  const [titleDraft, setTitleDraft] = useState("");
  const [renameError, setRenameError] = useState("");
  const savingTitle = useRef(false);
  const beginRename = (id: string, title: string) => { setEditing(id); setTitleDraft(title); setRenameError(""); };
  const saveTitle = async (id: string) => {
    if (savingTitle.current) return;
    const title = titleDraft.trim();
    if (!title) { setRenameError("A thread title is required."); return; }
    savingTitle.current = true;
    try { const result = await renameThread(id, title); applyTitle(id, result.title); setEditing(null); setRenameError(""); }
    catch (err) { setRenameError(err instanceof Error ? err.message : "Couldn't rename this thread."); }
    finally { savingTitle.current = false; }
  };
  const rail = useRef<HTMLDivElement>(null);
  const load = useCallback(async () => {
    setLoading(true);
    try { const data = await getThreads(); setThreads(data.threads); updateTabs(data.threads); setError(""); }
    catch { setError("Couldn't load the thread list. Your open tabs are still available."); }
    finally { setLoading(false); }
  }, [updateTabs]);
  const hasTabs = tabs.length > 0;
  useEffect(() => {
    if (!hasTabs && !open) return;
    void load();
    const interval = window.setInterval(() => void load(), 10000);
    return () => window.clearInterval(interval);
  }, [hasTabs, open, load]);
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k" && !event.repeat) {
        event.preventDefault(); setOpen((value) => !value); setQuery(""); setSelected(0);
      }
      if (event.altKey && event.shiftKey && ["ArrowLeft", "ArrowRight"].includes(event.key) && tabs.length > 1) {
        event.preventDefault();
        const index = tabs.findIndex((t) => t.id === currentId);
        navigate(tabs[(index + (event.key === "ArrowRight" ? 1 : tabs.length - 1) + tabs.length) % tabs.length]!.href);
      }
    };
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, [tabs, currentId, navigate]);
  useEffect(() => {
    const active = rail.current?.querySelector<HTMLElement>('[aria-current="page"]');
    active?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: reduce ? "instant" : "smooth" });
  }, [currentId, tabs.length, reduce]);

  const match = query.trim().toLowerCase();
  const candidates = [
    ...tabs.map((tab) => ({ id: tab.id, title: tab.title, repo: tab.repo, href: tab.href, status: tab.status })),
    ...threads.filter((t) => !tabs.some((tab) => tab.id === t.id)).map((t) => ({
      id: t.id, title: threadTitle(t), repo: t.repo, href: `/threads/${t.id}`, status: t.latestRun?.status ?? t.state,
    })),
  ].filter((t) => `${t.title} ${repositoryLabel(t.repo)}`.toLowerCase().includes(match));
  const selectedIndex = Math.min(selected, Math.max(0, candidates.length - 1));
  const choose = (href: string) => { setOpen(false); navigate(href); };
  const shortcutLabel = `${primaryModifier()} K`;
  return <>
    <div className="flex h-9 min-w-0 flex-1 items-center gap-1">
      <button type="button" onClick={() => { setOpen(true); setQuery(""); setSelected(0); }}
        aria-label="Switch threads" aria-keyshortcuts="Meta+K Control+K" className="flex h-8 shrink-0 items-center gap-2 rounded-lg px-2 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
        <Layers className="size-3.5" /><span className={hasTabs ? "hidden xl:inline" : ""}>Switch threads</span><kbd className="hidden rounded border border-border bg-card px-1.5 py-0.5 font-mono text-[10px] sm:inline">{shortcutLabel}</kbd>
      </button>
      {hasTabs && <div className="mx-2 h-4 w-px shrink-0 bg-border" />}
      <div ref={rail} className="min-w-0 flex-1 overflow-x-auto [scrollbar-width:none]">
        <nav aria-label="Open threads" className="flex w-max items-center gap-1 py-1">
          {tabs.map((tab) => {
            const active = tab.id === currentId;
            return <motion.div layout="position" transition={reduce ? { duration: 0 } : controlSpring} key={tab.id} className={cn("group flex max-w-60 items-center rounded-lg border border-transparent transition-colors", active ? "border-border bg-card shadow-xs" : "hover:bg-accent/60")}>
              {editing === tab.id ? <input autoFocus aria-label="Thread title" maxLength={160} value={titleDraft}
                onFocus={(e) => e.currentTarget.select()} onChange={(e) => setTitleDraft(e.target.value)}
                onBlur={() => void saveTitle(tab.id)} aria-invalid={!!renameError}
                onKeyDown={(e) => { if (e.nativeEvent.isComposing) return; if (e.key === "Enter") { e.preventDefault(); void saveTitle(tab.id); } else if (e.key === "Escape") { e.preventDefault(); setEditing(null); setRenameError(""); } }}
                className="mx-1 h-7 w-36 rounded-md border border-input bg-background px-2 text-xs" /> : <Link to={tab.href} aria-current={active ? "page" : undefined} title={`${tab.title} · ${repositoryLabel(tab.repo)} — double-click to rename`}
                onDoubleClick={(e) => { e.preventDefault(); beginRename(tab.id, tab.title); }}
                className="flex h-8 min-w-0 items-center gap-2 rounded-lg px-3 text-xs">
                <span aria-label={tab.status === "waiting" ? "Waiting for your answer" : tab.status === "running" ? "Agent working" : ""}
                  className={cn("size-1.5 shrink-0 rounded-full bg-muted-foreground/40", tab.status === "running" && "animate-pulse bg-success", tab.status === "waiting" && "bg-warning")} />
                <span className={cn("max-w-36 truncate", !active && "text-muted-foreground")}>{tab.title}</span>
                {draftIds.has(tab.id) && <span aria-label="Unsent draft" title="Unsent draft" className="size-1 shrink-0 rounded-full bg-foreground" />}
              </Link>}
              {active && editing !== tab.id && <button type="button" aria-label="Rename thread" title="Rename thread"
                onClick={() => beginRename(tab.id, tab.title)} className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"><Pencil className="size-3" /></button>}
              <button type="button" onClick={() => closeTab(tab.id)} aria-label={`Close thread tab: ${tab.title}`}
                title="Close tab only; the agent keeps working" className="mr-1 flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"><X className="size-3" /></button>
            </motion.div>;
          })}
        </nav>
      </div>
      {renameError && <p role="alert" className="max-w-40 truncate text-xs text-destructive" title={renameError}>{renameError}</p>}
      <IconButton label="Start a new thread" onClick={() => navigate("/threads/new")} className="shrink-0"><Plus className="size-4" /></IconButton>
    </div>
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="gap-0 overflow-hidden rounded-2xl p-0 sm:max-w-xl">
        <DialogHeader className="sr-only"><DialogTitle>Switch threads</DialogTitle><DialogDescription>Find an open or recent thread. Closing tabs never stops agents.</DialogDescription></DialogHeader>
        <div className="flex items-center gap-3 border-b border-border px-5 py-4"><Search className="size-4 shrink-0 text-muted-foreground" />
          <Input autoFocus role="combobox" aria-expanded="true" aria-controls="thread-switcher-results" aria-autocomplete="list"
            aria-activedescendant={candidates[selectedIndex] ? `switch-${candidates[selectedIndex]!.id}` : undefined}
            aria-label="Find a thread" placeholder="Find a thread or repository…" value={query}
            className="h-8 border-0 bg-transparent p-0 shadow-none focus-visible:ring-0"
            onChange={(e) => { setQuery(e.target.value); setSelected(0); }}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return;
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault(); setSelected((i) => (i + (e.key === "ArrowDown" ? 1 : candidates.length - 1)) % Math.max(1, candidates.length));
              } else if (e.key === "Enter" && candidates[selectedIndex]) { e.preventDefault(); choose(candidates[selectedIndex]!.href); }
            }} />
          {loading && <Loader2 className="mr-6 size-3.5 animate-spin text-muted-foreground" />}
        </div>
        {error && <p role="alert" className="px-5 pt-3 text-xs text-destructive">{error}</p>}
        <Highlight mode="parent" controlledItems click={false} value={candidates[selectedIndex]?.id ?? null}
          transition={reduce ? { duration: 0 } : controlSpring} exitDelay={0}
          containerClassName="max-h-[55vh] overflow-y-auto p-2" className="rounded-xl bg-muted">
        <div role="listbox" aria-label="Threads" id="thread-switcher-results">
          {candidates.map((t, i) => <HighlightItem key={t.id} value={t.id} asChild><button type="button" role="option" aria-selected={i === selectedIndex} id={`switch-${t.id}`}
            onMouseMove={() => setSelected(i)} onClick={() => choose(t.href)}
            className="relative z-10 flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left">
            <MessageSquare className="size-4 shrink-0 text-muted-foreground" /><span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{t.title}</span><span className="mt-1 block truncate text-xs text-muted-foreground">{repositoryLabel(t.repo)}</span></span>
            {t.id === currentId ? <Check className="size-4 text-muted-foreground" /> : tabs.some((tab) => tab.id === t.id) && <span className="text-[10px] text-muted-foreground">Open</span>}
          </button></HighlightItem>)}
          {!candidates.length && <p className="px-4 py-10 text-center text-sm text-muted-foreground">{loading ? "Loading threads…" : "No matching threads"}</p>}
        </div>
        </Highlight>
        <div className="flex items-center justify-between gap-3 border-t border-border bg-muted/20 px-5 py-3 text-[11px] text-muted-foreground"><span>↑ ↓ Navigate · Enter Switch · Esc Close</span><Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => choose("/threads/new")}><Plus className="size-3" />New thread</Button></div>
      </DialogContent>
    </Dialog>
  </>;
}
