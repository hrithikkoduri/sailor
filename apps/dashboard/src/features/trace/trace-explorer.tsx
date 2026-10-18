import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ChevronDown,
  Layers2,
  RefreshCw,
  Search,
} from "lucide-react";
import { getThreadTrace, type ThreadTrace } from "./api";
import { buildThreadTree, type SpanNode } from "./build-tree";
import { SpanRow } from "./components/span-row";
import { SpanDetail } from "./components/span-detail";
import { IconButton } from "@/elements/icon-button";
import { Button } from "@/elements/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/animate-ui/components/radix/dropdown-menu";
import { duration, fmtTokens, fmtUsd } from "@/utils/format";
import { cn } from "@/utils/cn";

const find = (nodes: SpanNode[], id: string): SpanNode | undefined => {
  for (const node of nodes) {
    if (node.id === id) return node;
    const child = find(node.children, id);
    if (child) return child;
  }
};
const ids = (nodes: SpanNode[]): string[] =>
  nodes.flatMap((n) => [n.id, ...ids(n.children)]);

export function TraceExplorer({
  threadId,
  focusRunId,
  version,
}: {
  threadId: string;
  focusRunId: string | null;
  version: number;
}) {
  const [data, setData] = useState<ThreadTrace | null>(null);
  const [selection, setSelection] = useState("thread");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [mobileDetail, setMobileDetail] = useState(false);
  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      setData(await getThreadTrace(threadId));
      setError("");
    } catch {
      setError("The trace could not be loaded. Please try again.");
    } finally {
      setRefreshing(false);
    }
  }, [threadId]);
  useEffect(() => {
    void load();
  }, [load, version]);
  // Deep links focus ONCE. A live refresh must not steal a span selection.
  useEffect(() => {
    setSelection(focusRunId ? `run-${focusRunId}` : "thread");
    setCollapsed(new Set());
  }, [threadId, focusRunId]);
  const tree = useMemo(
    () => (data ? buildThreadTree(data.runs, data.spans) : null),
    [data],
  );
  const threadNode: SpanNode | null = data
    ? {
        id: "thread",
        kind: "run",
        name: "Entire thread",
        status: data.runs.some((r) => r.status === "running")
          ? "running"
          : "neutral",
        startMs: new Date(data.thread.createdAt).getTime(),
        tokensIn: data.totals.tokensIn,
        tokensOut: data.totals.tokensOut,
        detail: {
          input: {
            repository: data.thread.repo,
            issue: data.thread.issueNumber,
            base: data.thread.baseRef,
          },
          output: {
            summary: data.thread.summary,
            pullRequest: data.thread.prUrl,
            state: data.thread.state,
          },
          metadata: {
            threadId: data.thread.id,
            ...data.totals,
            turnsUsed: data.thread.turnsUsed,
            turnBudget: data.thread.budgetMaxTurns,
            costBudget: data.thread.budgetMaxUsd,
            checkpoint: data.thread.checkpointSha,
            watch: data.thread.watch,
          },
        },
        children: [],
      }
    : null;
  const selected =
    selection === "thread"
      ? threadNode
      : tree
        ? find(tree.roots, selection)
        : null;
  if (!data || !tree)
    return (
      <div className="p-8 text-sm text-muted-foreground">
        {error || "Loading thread trace…"}
        {error && (
          <Button
            variant="outline"
            className="ml-3"
            onClick={() => void load()}
          >
            Retry
          </Button>
        )}
      </div>
    );
  const toggle = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div data-trace-metrics className="flex min-h-10 shrink-0 flex-wrap items-center gap-x-6 gap-y-1 border-b border-border bg-card/40 px-4 py-2 md:px-6">
        {[
          {
            label: "Turns",
            value: String(data.totals.runs),
            sub: `${data.totals.codingRuns} coding · ${data.totals.chatRuns} chat`,
          },
          {
            label: "Tokens",
            value: fmtTokens(data.totals.tokensIn + data.totals.tokensOut),
            sub: `${fmtTokens(data.totals.tokensIn)} in / ${fmtTokens(data.totals.tokensOut)} out`,
          },
          {
            label: "Cost",
            value: fmtUsd(data.totals.usd),
            sub: `of ${fmtUsd(data.thread.budgetMaxUsd)} budget`,
          },
          {
            label: "Elapsed",
            value: duration(
              data.totals.startedAt,
              data.runs.some((r) => ["queued", "running"].includes(r.status))
                ? null
                : data.totals.finishedAt,
            ),
            sub: "Across the whole thread",
          },
          {
            label: "Budget",
            value: `${data.thread.turnsUsed} / ${data.thread.budgetMaxTurns}`,
            sub: "Recorded usage",
          },
        ].map((metric) => (
          <div key={metric.label} title={metric.sub} className="flex items-baseline gap-2">
            <span className="text-[11px] text-muted-foreground">
              {metric.label}
            </span>
            <span className="text-xs font-medium tabular-nums">
              {metric.value}
            </span>
          </div>
        ))}
      </div>
      {error && (
        <p role="alert" className="px-5 py-2 text-xs text-destructive">
          {error}
        </p>
      )}
      <div className="flex gap-2 border-b border-border px-4 py-2 md:hidden">
        <Button
          size="sm"
          variant={mobileDetail ? "ghost" : "secondary"}
          onClick={() => setMobileDetail(false)}
        >
          Execution tree
        </Button>
        <Button
          size="sm"
          variant={mobileDetail ? "secondary" : "ghost"}
          onClick={() => setMobileDetail(true)}
        >
          Span details
        </Button>
      </div>
      <div data-trace-workspace className="flex min-h-0 flex-1 flex-col md:flex-row">
        <div
          className={cn(
            "min-h-0 flex-1 flex-col border-border md:flex md:w-[44%] md:max-w-[520px] md:flex-none md:border-r",
            mobileDetail ? "hidden" : "flex",
          )}
        >
          <div className="flex h-12 shrink-0 items-center gap-1.5 border-b border-border px-3">
            <div className="relative min-w-0 flex-1">
              <Search className="pointer-events-none absolute top-2 left-2.5 size-3.5 text-muted-foreground" />
              <Input aria-label="Search trace spans" placeholder="Find a span…" value={query} onChange={e => setQuery(e.target.value)} className="h-8 rounded-md bg-card pl-8 text-xs shadow-none" />
            </div>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-[11px]"
                >
                  View
                  <ChevronDown className="size-3" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => setCollapsed(new Set())}>
                  Expand all
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={() => setCollapsed(new Set(ids(tree.roots)))}
                >
                  Collapse all
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <IconButton label="Refresh trace" onClick={() => void load()}>
              <RefreshCw className={cn(refreshing && "animate-spin")} />
            </IconButton>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto pb-4">
            <button
              onClick={() => {
                setSelection("thread");
                setMobileDetail(true);
              }}
              className={cn(
                "flex w-full items-center gap-2 border-l-2 px-4 py-3 text-left text-xs font-medium",
                selection === "thread"
                  ? "border-selection-foreground bg-selection text-selection-foreground"
                  : "border-transparent hover:bg-muted/60",
              )}
            >
              <Layers2 className="size-3.5" />
              Entire thread
              <span className="ml-auto text-[10px] font-normal text-muted-foreground">
                {data.totals.runs} turns
              </span>
            </button>
            <ul className="mt-1">
              {tree.roots.map((root) => (
                <SpanRow
                  key={root.id}
                  node={root}
                  window={
                    tree.runWindows.get(root.id.slice(4)) ?? {
                      start: root.startMs,
                      end: root.startMs + (root.durationMs ?? 1),
                    }
                  }
                  selectedId={selection}
                  collapsed={collapsed}
                  query={query.toLowerCase()}
                  onToggle={toggle}
                  onSelect={(id) => {
                    setSelection(id);
                    setMobileDetail(true);
                  }}
                />
              ))}
            </ul>
          </div>
        </div>
        <div
          className={cn(
            "min-h-0 min-w-0 flex-1 overflow-y-auto bg-card/30 md:block",
            mobileDetail ? "block" : "hidden",
          )}
        >
          {selected ? (
            <SpanDetail key={selected.id} node={selected} />
          ) : (
            <p className="p-8 text-sm text-muted-foreground">
              Choose a span to inspect its input, output, and metadata.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
