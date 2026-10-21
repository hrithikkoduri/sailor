/** Client-side views only. Closing a tab never cancels work on the server. */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { getMe } from "@/features/auth/api";
import { threadTitle, type ThreadDetail, type ThreadListItem } from "@/features/threads/api";

export interface ThreadTab {
  id: string;
  title: string;
  repo: string;
  href: string;
  status: string;
}
interface Position { top: number; following: boolean }
type FormAnswers = Record<string, string | string[]>;
interface TabsState {
  tabs: ThreadTab[];
  draftIds: Set<string>;
  remember: (detail: ThreadDetail) => void;
  updateTabs: (threads: ThreadListItem[]) => void;
  closeTab: (id: string) => void;
  applyTitle: (id: string, title: string) => void;
  getDetail: (id: string) => ThreadDetail | undefined;
  getDraft: (id: string) => string;
  saveDraft: (id: string, text: string) => void;
  getPosition: (id: string) => Position | undefined;
  savePosition: (id: string, position: Position) => void;
  getFormDraft: (id: string) => FormAnswers | undefined;
  saveFormDraft: (id: string, answers: FormAnswers | null) => void;
}
const Context = createContext<TabsState | null>(null);
const activeId = (pathname: string) => /^\/threads\/(?!new$)([^/]+)$/.exec(pathname)?.[1];
const sameTabs = (a: ThreadTab[], b: ThreadTab[]) => JSON.stringify(a) === JSON.stringify(b);

export function ThreadTabsProvider({ children }: { children: ReactNode }) {
  const { pathname, search } = useLocation();
  const [owner, setOwner] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const authPage = pathname === "/login";
  const navigate = useNavigate();
  const [tabs, setTabs] = useState<ThreadTab[]>([]);
  const [draftIds, setDraftIds] = useState<Set<string>>(new Set());
  const details = useRef(new Map<string, ThreadDetail>());
  const drafts = useRef(new Map<string, string>());
  const positions = useRef(new Map<string, Position>());
  const forms = useRef(new Map<string, FormAnswers>());
  const hydrated = useRef<string | null>(null);

  useEffect(() => {
    if (authPage) { setOwner(null); setLoading(false); return; }
    let alive = true;
    setLoading(true);
    getMe().then((data) => { if (alive) setOwner(data.user.id); })
      .catch(() => { if (alive) setOwner(null); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [authPage]);

  // Metadata is session-scoped and namespaced by account. Drafts, file/tool
  // outputs, and conversation contents remain in memory, never browser storage.
  useEffect(() => {
    if (loading || hydrated.current === owner) return;
    hydrated.current = owner;
    details.current.clear(); drafts.current.clear(); positions.current.clear(); forms.current.clear();
    setDraftIds(new Set());
    let saved: ThreadTab[] = [];
    if (owner) {
      try {
        const raw: unknown = JSON.parse(sessionStorage.getItem(`sailor:thread-tabs:${owner}`) ?? "[]");
        if (Array.isArray(raw)) saved = raw.filter((t): t is ThreadTab =>
          t && typeof t.id === "string" && /^[a-zA-Z0-9-]{1,80}$/.test(t.id) &&
          typeof t.title === "string" && typeof t.repo === "string" && typeof t.status === "string" &&
          typeof t.href === "string" && t.href.split("?")[0] === `/threads/${t.id}`,
        );
      } catch { /* Private browsing/storage failures must not break navigation. */ }
    }
    setTabs(saved);
  }, [owner, loading]);

  useEffect(() => {
    if (!owner || hydrated.current !== owner) return;
    try { sessionStorage.setItem(`sailor:thread-tabs:${owner}`, JSON.stringify(tabs)); } catch { /* optional */ }
  }, [tabs, owner]);

  useEffect(() => {
    const id = activeId(pathname);
    if (!id) return;
    setTabs((previous) => {
      const next = previous.map((t) => t.id === id ? { ...t, href: pathname + search } : t);
      return sameTabs(previous, next) ? previous : next;
    });
  }, [pathname, search, tabs.length]);

  const remember = useCallback((detail: ThreadDetail) => {
    if (!owner || hydrated.current !== owner) return;
    details.current.delete(detail.thread.id);
    details.current.set(detail.thread.id, detail);
    // Bound heavy conversation data, not the user's open tab list.
    if (details.current.size > 20) details.current.delete(details.current.keys().next().value!);
    const run = detail.runs[0];
    const status = detail.questions?.some((q) => q.status === "pending") ? "waiting"
      : run && ["running", "queued"].includes(run.status) ? run.status : detail.thread.state;
    const issueTitle = detail.events.find((e) => e.kind === "issue_labeled")?.payload.title;
    const tab: ThreadTab = { id: detail.thread.id, title: detail.thread.title ?? (typeof issueTitle === "string" ? issueTitle : threadTitle(detail.thread)), repo: detail.thread.repo,
      status, href: `/threads/${detail.thread.id}` };
    setTabs((previous) => {
      const existing = previous.find((t) => t.id === tab.id);
      const next = existing ? previous.map((t) => t.id === tab.id ? { ...tab, href: t.href } : t) : [...previous, tab];
      return sameTabs(previous, next) ? previous : next;
    });
  }, [owner]);

  const updateTabs = useCallback((threads: ThreadListItem[]) => {
    setTabs((previous) => {
      const next = previous.map((tab) => {
        const t = threads.find((t) => t.id === tab.id);
        if (!t) return tab; // the list is paginated; absence is not deletion
        const run = t.latestRun;
        return { ...tab, title: threadTitle(t), repo: t.repo,
          status: run?.status === "paused" && run.disposition === "blocked" ? "waiting"
            : run && ["running", "queued"].includes(run.status) ? run.status : t.state };
      });
      return sameTabs(previous, next) ? previous : next;
    });
  }, []);

  const closeTab = useCallback((id: string) => {
    const index = tabs.findIndex((t) => t.id === id);
    const remaining = tabs.filter((t) => t.id !== id);
    setTabs(remaining);
    if (activeId(pathname) === id) navigate(remaining[Math.max(0, index - 1)]?.href ?? "/threads");
  }, [tabs, pathname, navigate]);
  const applyTitle = useCallback((id: string, title: string) => {
    const cached = details.current.get(id);
    if (cached) details.current.set(id, { ...cached, thread: { ...cached.thread, title } });
    setTabs((previous) => previous.map((t) => t.id === id ? { ...t, title } : t));
  }, []);
  const getDetail = useCallback((id: string) => details.current.get(id), []);
  const getDraft = useCallback((id: string) => drafts.current.get(id) ?? "", []);
  const getPosition = useCallback((id: string) => positions.current.get(id), []);
  const savePosition = useCallback((id: string, position: Position) => { positions.current.set(id, position); }, []);
  const getFormDraft = useCallback((id: string) => forms.current.get(id), []);
  const saveFormDraft = useCallback((id: string, answers: FormAnswers | null) => {
    if (answers) forms.current.set(id, answers); else forms.current.delete(id);
  }, []);
  const saveDraft = useCallback((id: string, text: string) => {
    const hadDraft = !!drafts.current.get(id)?.trim();
    if (text) drafts.current.set(id, text); else drafts.current.delete(id);
    if (hadDraft !== !!text.trim()) setDraftIds((previous) => {
      const next = new Set(previous);
      if (text.trim()) next.add(id); else next.delete(id);
      return next;
    });
  }, []);
  const value = useMemo(() => ({ tabs, draftIds, remember, updateTabs, closeTab, applyTitle, getDetail, getDraft, saveDraft, getPosition, savePosition, getFormDraft, saveFormDraft }),
    [tabs, draftIds, remember, updateTabs, closeTab, applyTitle, getDetail, getDraft, saveDraft, getPosition, savePosition, getFormDraft, saveFormDraft]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useThreadTabs() {
  const value = useContext(Context);
  if (!value) throw new Error("Thread tabs need ThreadTabsProvider");
  return value;
}
