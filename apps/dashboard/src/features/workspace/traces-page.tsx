import { useCallback, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Activity, ArrowUpRight, ChevronLeft, ChevronRight, Search } from "lucide-react";
import { getTraces, repositoryLabel, type TraceRow } from "@/features/threads/api";
import { usePoll } from "@/hooks/use-poll";
import { ApiError } from "@/utils/api-client";
import { StatusPill } from "@/elements/status-pill";
import { Button } from "@/elements/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/elements/select";
import { Input } from "@/components/ui/input";
import { timeAgo } from "@/utils/format";
import { WorkspacePage } from "./workspace-page";

const OUTCOMES = ["all", "running", "queued", "succeeded", "failed", "paused", "cancelled", "budget_exhausted"];

export function TracesPage() {
  const navigate = useNavigate();
  const [page, setPage] = useState(0); const [rows, setRows] = useState<TraceRow[] | null>(null);
  const [hasMore, setHasMore] = useState(false); const [error, setError] = useState("");
  const [query, setQuery] = useState(""); const [status, setStatus] = useState("all");
  const load = useCallback(async () => {
    try { const data = await getTraces(page); setRows(data.traces); setHasMore(data.hasMore); setError(""); }
    catch (err) { if (err instanceof ApiError && err.status === 401) navigate("/login"); else setError("Traces couldn't be loaded. Try again."); }
  }, [page, navigate]);
  usePoll(load, 10000);
  const visible = (rows ?? []).filter((r) => (status === "all" || r.status === status) && `${r.title ?? ""} ${r.task ?? ""} ${r.repo} ${r.id}`.toLowerCase().includes(query.toLowerCase()));
  return <WorkspacePage eyebrow="The evidence, not just the answer" title="See how the work happened." description="A run-by-run view of actions, tokens, timing, and outcomes. Open any trace to inspect the full execution.">
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3"><div className="flex items-center gap-2 text-xs text-muted-foreground">Outcome
      <Select value={status} onValueChange={setStatus}>
        <SelectTrigger aria-label="Filter traces by outcome" className="w-40 bg-card"><SelectValue /></SelectTrigger>
        <SelectContent>{OUTCOMES.map((outcome) => <SelectItem key={outcome} value={outcome}>{outcome === "all" ? "All outcomes" : outcome.replace(/_/g, " ")}</SelectItem>)}</SelectContent>
      </Select></div>
      <div className="relative"><Search className="absolute top-3 left-3 size-3.5 text-muted-foreground" /><Input value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search traces on this page" placeholder="Search this page…" className="h-10 w-64 bg-card pl-9" /></div>
    </div>
    {error && <p role="alert" className="mb-3 text-sm text-destructive">{error}</p>}
    <div className="overflow-x-auto rounded-xl border border-border bg-card"><table className="w-full min-w-[820px] text-left text-sm">
      <thead className="border-b border-border bg-muted/20 text-xs text-muted-foreground"><tr>{["Run / thread", "Outcome", "Steps", "Tokens", "Cost", "Duration", "Started"].map((h) => <th key={h} className="px-4 py-3 font-medium first:pl-5">{h}</th>)}</tr></thead>
      <tbody>{visible.map((r) => {
        const duration = r.startedAt ? Math.max(0, Math.round((new Date(r.finishedAt ?? Date.now()).getTime() - new Date(r.startedAt).getTime()) / 1000)) : null;
        return <tr key={r.id} className="border-b border-border last:border-0 hover:bg-muted/30"><td className="max-w-80 px-5 py-4"><Link to={`/threads/${r.threadId}?run=${r.id}`} className="group block"><span className="flex items-center gap-2 font-medium"><span className="truncate">{r.title ?? r.task?.split("\n")[0] ?? "Agent run"}</span><ArrowUpRight className="size-3.5 shrink-0 text-muted-foreground" /></span><span className="mt-1 block truncate text-xs text-muted-foreground">{repositoryLabel(r.repo)} · <span className="font-mono">{r.id.slice(0, 8)}</span></span></Link></td>
          <td className="px-4 py-4"><StatusPill status={r.status} /></td><td className="px-4 py-4 font-mono text-xs">{r.steps}</td><td className="px-4 py-4 font-mono text-xs">{(r.tokensIn + r.tokensOut).toLocaleString()}</td><td className="px-4 py-4 font-mono text-xs">${Number(r.usd).toFixed(4)}</td><td className="px-4 py-4 text-xs text-muted-foreground">{duration === null ? "—" : duration < 60 ? `${duration}s` : `${Math.floor(duration / 60)}m ${duration % 60}s`}</td><td className="px-4 py-4 text-xs text-muted-foreground">{timeAgo(r.startedAt ?? r.createdAt)}</td></tr>;
      })}</tbody>
    </table>{!visible.length && <div className="px-6 py-16 text-center"><Activity className="mx-auto mb-3 size-6 text-muted-foreground" /><p className="text-sm font-medium">{rows === null ? "Loading traces…" : "No traces in this view"}</p><p className="mt-2 text-xs text-muted-foreground">{query || status !== "all" ? "Try another filter or page." : "Start a thread to see its execution here."}</p></div>}</div>
    <div className="mt-4 flex items-center justify-between text-xs text-muted-foreground"><p>Page {page + 1} · Latest 50 runs per page · Updates automatically</p><div className="flex gap-2"><Button variant="outline" size="sm" disabled={!page} onClick={() => { setRows(null); setPage((p) => p - 1); }}><ChevronLeft className="size-3.5" />Previous</Button><Button variant="outline" size="sm" disabled={!hasMore} onClick={() => { setRows(null); setPage((p) => p + 1); }}>Next<ChevronRight className="size-3.5" /></Button></div></div>
  </WorkspacePage>;
}
