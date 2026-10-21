import { useCallback, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Inbox, RefreshCw, Search, Plus } from "lucide-react";
import { getThreads, type ThreadListItem } from "@/features/threads/api";
import { ThreadRow } from "./components/thread-row";
import { AppShell } from "@/features/shell/app-shell";
import { Button } from "@/elements/button";
import { IconButton } from "@/elements/icon-button";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from "@/components/animate-ui/components/radix/tabs";
import { usePoll } from "@/hooks/use-poll";
import { ApiError } from "@/utils/api-client";

export function ThreadsPage() {
  const navigate = useNavigate();
  const [threads, setThreads] = useState<ThreadListItem[] | null>(null);
  const [filter, setFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    try {
      setThreads((await getThreads()).threads);
      setError("");
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) navigate("/login");
      else setError("Threads could not be loaded. Try refreshing.");
    }
  }, [navigate]);
  usePoll(load, 5000);
  const active = (t: ThreadListItem) =>
    ["queued", "running"].includes(t.latestRun?.status ?? "");
  const visible = useMemo(
    () =>
      (threads ?? []).filter(
        (t) =>
          (filter !== "active" || active(t)) &&
          (filter !== "prs" || !!t.prUrl) &&
          `${t.title ?? ""} ${t.repo} ${t.issueNumber} ${t.latestRun?.task ?? ""}`
            .toLowerCase()
            .includes(query.toLowerCase()),
      ),
    [threads, filter, query],
  );

  return (
    <AppShell
      topbar={
        <span className="text-sm text-muted-foreground">
          Workspace <span className="mx-2 text-input">/</span>{" "}
          <span className="text-foreground">Threads</span>
        </span>
      }
    >
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-6xl px-5 py-8 md:px-10 md:py-12">
          <div className="mb-9 flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="eyebrow mb-2">Your agent workspace</p>
              <h1 className="page-heading">A thread for every idea.</h1>
              <p className="mt-2 max-w-lg text-sm leading-relaxed text-muted-foreground">
                Follow the work, join the conversation, and see exactly how your
                agent got there.
              </p>
            </div>
            <Button variant="outline" asChild>
              <Link to="/threads/new">
                New thread
                <Plus className="size-3.5" />
              </Link>
            </Button>
          </div>
          <Tabs value={filter} onValueChange={setFilter} className="gap-0">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <TabsList
                aria-label="Filter threads"
                className="h-10 bg-muted/60"
              >
                <TabsTrigger value="all" className="px-3 text-xs">
                  All threads{" "}
                  <span className="ml-1 text-muted-foreground">
                    {threads?.length ?? 0}
                  </span>
                </TabsTrigger>
                <TabsTrigger value="active" className="px-3 text-xs">
                  Active{" "}
                  <span className="ml-1 text-muted-foreground">
                    {threads?.filter(active).length ?? 0}
                  </span>
                </TabsTrigger>
                <TabsTrigger value="prs" className="px-3 text-xs">
                  Pull requests
                </TabsTrigger>
              </TabsList>
              <div className="flex items-center gap-2">
                <div className="relative">
                  <Search className="pointer-events-none absolute top-2.5 left-3 size-3.5 text-muted-foreground" />
                  <Input
                    aria-label="Search threads"
                    placeholder="Search threads…"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    className="h-9 w-52 rounded-lg bg-card pl-9 text-xs shadow-none"
                  />
                </div>
                <IconButton label="Refresh threads" onClick={() => void load()}>
                  <RefreshCw />
                </IconButton>
              </div>
            </div>
            <TabsContent
              value={filter}
              className="mt-0"
              transition={{ duration: 0.15 }}
            >
              {error && (
                <p role="alert" className="mb-4 text-sm text-destructive">
                  {error}
                </p>
              )}
              {threads === null ? (
                <div className="space-y-2">
                  {[0, 1, 2].map((i) => (
                    <Skeleton key={i} className="h-20 rounded-xl" />
                  ))}
                </div>
              ) : visible.length ? (
                <div className="overflow-hidden rounded-xl border border-border bg-card">
                  <div className="flex items-center justify-between border-b border-border bg-muted/20 px-5 py-3 text-[11px] font-medium text-muted-foreground">
                    <span>CONVERSATIONS</span>
                    <span>
                      {visible.length} thread{visible.length === 1 ? "" : "s"}
                    </span>
                  </div>
                  {visible.map((t) => (
                    <ThreadRow key={t.id} thread={t} />
                  ))}
                </div>
              ) : (
                <div className="surface flex flex-col items-center px-6 py-20 text-center">
                  <Inbox className="mb-5 size-7 text-muted-foreground" />
                  <h2 className="text-base font-medium">
                    {query || filter !== "all"
                      ? "No matching threads"
                      : "Your next fix starts here"}
                  </h2>
                  <p className="mt-2 max-w-sm text-sm leading-relaxed text-muted-foreground">
                    {query || filter !== "all" ? (
                      "Try another search or choose a different view."
                    ) : (
                      <>
                        Start with a message and optionally attach a repository.
                        GitHub issues labeled <code className="rounded bg-muted px-1 py-0.5 text-xs">agent:fix</code> appear here too.
                      </>
                    )}
                  </p>
                  {!query && filter === "all" && (
                    <Button className="mt-6" asChild>
                      <Link to="/threads/new">Start a thread</Link>
                    </Button>
                  )}
                </div>
              )}
            </TabsContent>
          </Tabs>
          <p className="mt-5 text-xs text-muted-foreground">
            Updates automatically · Start from a message, a repository, or a GitHub issue.
          </p>
        </div>
      </div>
    </AppShell>
  );
}
