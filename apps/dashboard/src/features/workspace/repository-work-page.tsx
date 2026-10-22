import { useCallback, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { CircleDot, GitPullRequest, Search, ExternalLink, ArrowUpRight } from "lucide-react";
import { getThreads, threadTitle, type ThreadListItem } from "@/features/threads/api";
import { usePoll } from "@/hooks/use-poll";
import { ApiError } from "@/utils/api-client";
import { StatusPill } from "@/elements/status-pill";
import { Button } from "@/elements/button";
import { Input } from "@/components/ui/input";
import { plural, timeAgo } from "@/utils/format";
import { WorkspacePage } from "./workspace-page";

export function RepositoryWorkPage({ kind }: { kind: "issues" | "prs" }) {
  const navigate = useNavigate();
  const [threads, setThreads] = useState<ThreadListItem[] | null>(null);
  const [query, setQuery] = useState(""); const [error, setError] = useState("");
  const prs = kind === "prs"; const Icon = prs ? GitPullRequest : CircleDot;
  const load = useCallback(async () => {
    try { setThreads((await getThreads()).threads); setError(""); }
    catch (err) { if (err instanceof ApiError && err.status === 401) navigate("/login"); else setError("Couldn't load repository work."); }
  }, [navigate]);
  usePoll(load, 10000);
  const rows = useMemo(() => (threads ?? []).filter((t) => (prs ? !!t.prUrl : t.source === "github") &&
    `${t.repo} ${threadTitle(t)} ${t.issueNumber} ${t.prNumber}`.toLowerCase().includes(query.toLowerCase())), [threads, query, prs]);
  return <WorkspacePage eyebrow="Connected work" title={prs ? "From fix to feedback." : "Every issue has a thread."}
    description={prs ? "Pull requests created or tracked by Sailor, with the conversation and evidence behind each change." : <>GitHub issues Sailor is working on. Label an enabled repository’s issue <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[12px]">agent:fix</code> to bring it here.</>}
    action={<Button variant="outline" asChild><Link to="/settings">Manage repositories <ArrowUpRight className="size-3.5" /></Link></Button>}>
    <div className="mb-4 flex items-center justify-between gap-3"><p className="text-xs text-muted-foreground">{prs ? plural(rows.length, "tracked pull request") : plural(rows.length, "tracked issue")}</p>
      <div className="relative"><Search className="absolute left-3 top-3 size-3.5 text-muted-foreground" /><Input aria-label={prs ? "Search pull requests" : "Search issues"} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search repository or title…" className="h-10 w-64 bg-card pl-9" /></div>
    </div>
    {error && <p role="alert" className="mb-4 text-sm text-destructive">{error}</p>}
    <div className="overflow-x-auto rounded-xl border border-border bg-card"><table className="w-full min-w-[600px] text-left text-sm"><thead className="border-b border-border bg-muted/20 text-xs text-muted-foreground"><tr><th className="px-5 py-3 font-medium">{prs ? "Pull request" : "Issue"}</th><th className="px-4 py-3 font-medium">State</th><th className="px-4 py-3 font-medium">Updated</th><th className="px-4 py-3"><span className="sr-only">GitHub</span></th></tr></thead>
      <tbody>{rows.map((t) => <tr key={t.id} className="border-b border-border last:border-0 hover:bg-muted/30"><td className="px-5 py-4"><Link to={`/threads/${t.id}`} className="flex items-start gap-3"><Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" /><span><span className="block font-medium">{threadTitle(t)}</span><span className="mt-1 block text-xs text-muted-foreground">{t.repo} · #{prs ? t.prNumber : t.issueNumber}</span></span></Link></td><td className="px-4 py-4"><StatusPill status={t.state} /></td><td className="px-4 py-4 text-xs text-muted-foreground">{timeAgo(t.updatedAt)}</td><td className="px-4 py-4"><a href={prs ? t.prUrl! : `https://github.com/${t.repo}/issues/${t.issueNumber}`} target="_blank" rel="noreferrer" aria-label={`Open ${prs ? "pull request" : "issue"} on GitHub`} className="flex size-10 items-center justify-center rounded-lg hover:bg-accent"><ExternalLink className="size-4 text-muted-foreground" /></a></td></tr>)}</tbody>
    </table>{!rows.length && <div className="px-6 py-16 text-center"><Icon className="mx-auto mb-3 size-6 text-muted-foreground" /><p className="text-sm font-medium">{threads === null ? "Loading…" : query ? "No matches" : prs ? "No pull requests yet" : "No issues tracked yet"}</p><p className="mt-2 text-xs text-muted-foreground">{query ? "Try a different search." : "Repository work will appear here as Sailor picks it up."}</p></div>}</div>
  </WorkspacePage>;
}
