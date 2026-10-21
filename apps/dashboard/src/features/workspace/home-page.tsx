import { useCallback, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Activity, ArrowUpRight, CircleDot, GitPullRequest, MessageSquare } from "lucide-react";
import { getThreads, type ThreadListItem } from "@/features/threads/api";
import { ThreadRow } from "@/features/threads/components/thread-row";
import { usePoll } from "@/hooks/use-poll";
import { useUser } from "@/hooks/use-user";
import { ApiError } from "@/utils/api-client";
import { WorkspacePage } from "./workspace-page";
import { NewThreadComposer } from "./new-thread-composer";

export function HomePage() {
  const { user } = useUser();
  const navigate = useNavigate();
  const [threads, setThreads] = useState<ThreadListItem[]>([]);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    try { setThreads((await getThreads()).threads); setError(""); }
    catch (err) { if (err instanceof ApiError && err.status === 401) navigate("/login"); else setError("Recent activity couldn't be loaded."); }
  }, [navigate]);
  usePoll(load, 10000);
  const active = threads.filter((t) => ["running", "queued"].includes(t.latestRun?.status ?? "")).length;
  const name = user?.name?.split(" ")[0] ?? user?.login;
  return <WorkspacePage section="Home" eyebrow="Your engineering companion" title={name ? `What’s next, ${name}?` : "A little less busywork."}
    description="A new idea, a stubborn bug, or a question worth exploring. Start a conversation and follow the work here.">
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_240px] lg:gap-10">
      <div><NewThreadComposer /><div className="mt-4 flex flex-wrap gap-x-5 gap-y-2 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5"><MessageSquare className="size-3.5" /> One thread, all the context</span>
        <span className="flex items-center gap-1.5"><Activity className="size-3.5" /> Every step accounted for</span>
      </div></div>
      <aside className="grid grid-cols-3 gap-3 lg:grid-cols-1 lg:gap-0 lg:divide-y lg:divide-border">
        {[{ label: "In progress", value: active, icon: Activity, to: "/threads" },
          { label: "Tracked issues", value: threads.filter((t) => t.source === "github").length, icon: CircleDot, to: "/issues" },
          { label: "Pull requests", value: threads.filter((t) => t.prUrl).length, icon: GitPullRequest, to: "/pull-requests" }].map((item) =>
          <Link key={item.label} to={item.to} className="group rounded-lg p-3 transition-colors hover:bg-muted/60 lg:py-4">
            <span className="flex items-center gap-2 text-xs text-muted-foreground"><item.icon className="size-3.5" />{item.label}</span>
            <span className="mt-2 flex items-center justify-between text-2xl font-medium tracking-tight">{item.value}<ArrowUpRight className="size-4 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" /></span>
          </Link>)}
      </aside>
    </div>
    <section className="mt-12"><div className="mb-4 flex items-center justify-between"><h2 className="text-sm font-medium">Pick up where you left off</h2><Link to="/threads" className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">All threads <ArrowUpRight className="size-3.5" /></Link></div>
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : threads.length ?
        <div className="overflow-hidden rounded-xl border border-border bg-card">{threads.slice(0, 5).map((t) => <ThreadRow key={t.id} thread={t} />)}</div> :
        <div className="rounded-xl border border-dashed border-input px-6 py-10 text-center"><MessageSquare className="mx-auto mb-3 size-5 text-muted-foreground" /><h3 className="text-sm font-medium">Your next thread starts above</h3><p className="mt-1 text-xs text-muted-foreground">No issue or pull request needed.</p></div>}
    </section>
  </WorkspacePage>;
}

export function NewThreadPage() {
  return <WorkspacePage section="New thread" eyebrow="Start something" title="What are we working on?" description="Give Sailor a clear goal. Attach a repository if you already know where the work belongs."><div className="max-w-3xl"><NewThreadComposer /></div></WorkspacePage>;
}
