/**
 * TraceExplorer — the whole thread as one span tree (LangSmith-inspired):
 * runs → phases → agent steps → tool calls, each with duration/token chips
 * and a waterfall bar; the right pane shows the selected span's
 * Input / Output / Metadata. `focusRunId` (the ?run= param) pre-selects a run.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Bot,
  ChevronDown,
  ChevronRight,
  Info,
  Milestone,
  PlayCircle,
  RefreshCw,
  Wrench,
} from "lucide-react";
import { getThreadTrace, type ThreadTrace } from "@/features/trace/api";
import { buildThreadTree, type SpanNode } from "@/features/trace/build-tree";
import { Markdown } from "@/elements/markdown";
import { duration, fmtTokens, fmtUsd } from "@/utils/format";
import { cn } from "@/utils/cn";

const KIND_ICON = { run: PlayCircle, phase: Milestone, llm: Bot, tool: Wrench, note: Info } as const;

const KIND_TONE: Record<string, string> = {
  run: "text-slate-300",
  phase: "text-muted-foreground/80",
  llm: "text-primary/90",
  tool: "text-sky-300/80",
  note: "text-muted-foreground/70",
};

const STATUS_BG: Record<string, string> = {
  ok: "bg-primary",
  fail: "bg-destructive",
  running: "bg-primary animate-pulse",
  neutral: "bg-slate-600",
};

const BAR_TONE: Record<string, string> = {
  run: "bg-slate-400/25",
  phase: "bg-slate-500/25",
  llm: "bg-primary/45",
  tool: "bg-sky-400/45",
  note: "bg-amber-400/40",
};

const ms = (value: number | undefined): string => {
  if (value === undefined) return "";
  if (value >= 1000) return `${(value / 1000).toFixed(2)}s`;
  return `${Math.round(value)}ms`;
};

export function TraceExplorer({
  threadId,
  focusRunId,
  version,
}: {
  threadId: string;
  focusRunId: string | null;
  /** Bump to refetch (the page increments this on live nudges). */
  version: number;
}) {
  const [data, setData] = useState<ThreadTrace | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      setData(await getThreadTrace(threadId));
      setError(null);
    } catch {
      setError("Could not load the trace.");
    } finally {
      setRefreshing(false);
    }
  }, [threadId]);

  useEffect(() => {
    void load();
  }, [load, version]);

  const tree = useMemo(() => (data ? buildThreadTree(data.runs, data.spans) : null), [data]);

  // Focus the ?run= run when present; otherwise keep/seed the selection.
  useEffect(() => {
    if (!tree) return;
    if (focusRunId) {
      const id = `run-${focusRunId}`;
      if (tree.roots.some((r) => r.id === id)) {
        setSelectedId(id);
        setCollapsed((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
        return;
      }
    }
    setSelectedId((prev) => prev ?? tree.roots[0]?.id ?? null);
  }, [tree, focusRunId]);

  const selected = useMemo(() => (tree && selectedId ? findNode(tree.roots, selectedId) : null), [tree, selectedId]);

  const toggle = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  if (error) return <p className="p-6 text-sm text-muted-foreground">{error}</p>;
  if (!data || !tree) return <p className="p-6 text-sm text-muted-foreground">Loading trace…</p>;

  const { totals, thread } = data;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* thread-level header — whatever the thread recorded, in one place */}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1 border-b border-border/60 px-5 py-2.5 font-mono text-[11px] text-muted-foreground">
        <span className="text-slate-300">thread trace</span>
        <span>
          {totals.runs} runs{" "}
          <span className="text-muted-foreground/60">
            ({totals.codingRuns} coding · {totals.chatRuns} chat)
          </span>
        </span>
        <span>
          ↑ {fmtTokens(totals.tokensIn)} ↓ {fmtTokens(totals.tokensOut)} tokens
        </span>
        <span>{fmtUsd(totals.usd)}</span>
        <span>wall {duration(totals.startedAt, totals.finishedAt)}</span>
        <span>
          {thread.turnsUsed}/{thread.budgetMaxTurns} turns
        </span>
        <button
          onClick={() => void load()}
          aria-label="Refresh trace"
          className="ml-auto flex size-6 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <RefreshCw className={cn("size-3", refreshing && "animate-spin")} />
        </button>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* span tree */}
        <div className="min-h-0 w-[400px] shrink-0 overflow-y-auto border-r border-border/60 py-1.5">
          {tree.roots.map((root) => (
            <SpanRow
              key={root.id}
              node={root}
              depth={0}
              window={tree.runWindows.get(root.id.slice("run-".length)) ?? null}
              selectedId={selectedId}
              collapsed={collapsed}
              onToggle={toggle}
              onSelect={setSelectedId}
            />
          ))}
        </div>

        {/* span detail */}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {selected ? (
            <SpanDetail key={selected.id} node={selected} />
          ) : (
            <p className="p-6 text-xs text-muted-foreground">Select a span.</p>
          )}
        </div>
      </div>
    </div>
  );
}

function findNode(nodes: SpanNode[], id: string): SpanNode | null {
  for (const node of nodes) {
    if (node.id === id) return node;
    const hit = findNode(node.children, id);
    if (hit) return hit;
  }
  return null;
}

function SpanRow({
  node,
  depth,
  window,
  selectedId,
  collapsed,
  onToggle,
  onSelect,
}: {
  node: SpanNode;
  depth: number;
  window: { start: number; end: number } | null;
  selectedId: string | null;
  collapsed: Set<string>;
  onToggle: (id: string) => void;
  onSelect: (id: string) => void;
}) {
  const Icon = KIND_ICON[node.kind];
  const hasKids = node.children.length > 0;
  const isCollapsed = collapsed.has(node.id);
  const span = window ? Math.max(1, window.end - window.start) : undefined;
  const left = window && span ? ((node.startMs - window.start) / span) * 100 : 0;
  const width = span && node.durationMs !== undefined ? Math.max(1.5, (node.durationMs / span) * 100) : 2;
  const tokens = (node.tokensIn ?? 0) + (node.tokensOut ?? 0);

  return (
    <div>
      <div
        role="button"
        tabIndex={0}
        onClick={() => onSelect(node.id)}
        onKeyDown={(e) => {
          if (e.key === "Enter") onSelect(node.id);
        }}
        className={cn(
          "flex cursor-pointer items-center gap-1.5 py-[3px] pr-3 transition-colors",
          selectedId === node.id ? "bg-primary/10" : "hover:bg-muted/30",
        )}
        style={{ paddingLeft: 8 + depth * 14 }}
      >
        {hasKids ? (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onToggle(node.id);
            }}
            aria-label={isCollapsed ? "Expand" : "Collapse"}
            className="flex size-4 shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground/70 hover:text-foreground"
          >
            {isCollapsed ? <ChevronRight className="size-3" /> : <ChevronDown className="size-3" />}
          </button>
        ) : (
          <span className="w-4 shrink-0" />
        )}
        <Icon className={cn("size-3.5 shrink-0", KIND_TONE[node.kind])} />
        <span className={cn("min-w-0 flex-1 truncate font-mono text-[11px]", node.kind === "run" && "text-slate-200")}>
          {node.name}
        </span>
        <span className={cn("size-1.5 shrink-0 rounded-full", STATUS_BG[node.status])} />
        <span className="w-9 shrink-0 text-right font-mono text-[10px] tabular-nums text-muted-foreground/80">
          {tokens > 0 ? `${fmtTokens(tokens)}t` : ""}
        </span>
        <span
          className={cn(
            "w-12 shrink-0 text-right font-mono text-[10px] tabular-nums text-muted-foreground/80",
            node.estimated && "text-muted-foreground/50",
          )}
        >
          {ms(node.durationMs)}
        </span>
        {/* waterfall bar — aligned column across every row */}
        <span className="relative h-1 w-20 shrink-0 overflow-hidden rounded-full bg-muted/30">
          <span
            className={cn("absolute top-0 h-full rounded-full", BAR_TONE[node.kind])}
            style={{ left: `${Math.min(99.5, left)}%`, width: `${Math.min(100 - Math.min(99.5, left), width)}%` }}
          />
        </span>
      </div>
      {!isCollapsed &&
        node.children.map((child) => (
          <SpanRow
            key={child.id}
            node={child}
            depth={depth + 1}
            window={window}
            selectedId={selectedId}
            collapsed={collapsed}
            onToggle={onToggle}
            onSelect={onSelect}
          />
        ))}
    </div>
  );
}

function SpanDetail({ node }: { node: SpanNode }) {
  const outputText =
    node.kind === "llm" ? ((node.detail.output as { text?: string } | undefined)?.text ?? "") : "";

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-5">
      <header className="flex flex-wrap items-center gap-2.5">
        {(() => {
          const Icon = KIND_ICON[node.kind];
          return <Icon className={cn("size-4", KIND_TONE[node.kind])} />;
        })()}
        <h2 className="font-mono text-sm text-slate-200">{node.name}</h2>
        <span className={cn("size-1.5 rounded-full", STATUS_BG[node.status])} />
        <span className="font-mono text-[10.5px] text-muted-foreground">
          {node.estimated ? "~" : ""}
          {ms(node.durationMs)}
          {node.tokensIn !== undefined && (
            <>
              {" "}
              · ↑{fmtTokens(node.tokensIn)} ↓{fmtTokens(node.tokensOut ?? 0)}
            </>
          )}
          {node.badge && ` · ${node.badge}`}
        </span>
      </header>

      {node.detail.input !== undefined && (
        <Section title="Input">
          <Value value={node.detail.input} />
        </Section>
      )}

      {node.detail.output !== undefined && (
        <Section title="Output">
          {node.kind === "llm" && outputText ? (
            <div className="rounded-xl border border-border/70 bg-card/40 p-4">
              <Markdown text={outputText} className="text-[13.5px]" />
            </div>
          ) : (
            <Value value={node.detail.output} />
          )}
        </Section>
      )}

      <Section title="Metadata">
        <MetadataView metadata={node.detail.metadata} />
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="mb-2 font-mono text-[10.5px] tracking-widest text-muted-foreground uppercase">{title}</h3>
      {children}
    </section>
  );
}

function Value({ value }: { value: unknown }) {
  if (value === undefined || value === null) return <p className="text-xs text-muted-foreground">—</p>;
  if (typeof value === "string") {
    return (
      <pre className="max-h-[28rem] overflow-auto rounded-xl border border-border/70 bg-[#0b1322] p-4 font-mono text-xs leading-relaxed whitespace-pre-wrap text-slate-200">
        {value}
      </pre>
    );
  }
  return (
    <pre className="max-h-[28rem] overflow-auto rounded-xl border border-border/70 bg-[#0b1322] p-4 font-mono text-xs leading-relaxed text-slate-200">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

function MetadataView({ metadata }: { metadata: Record<string, unknown> }) {
  const entries = Object.entries(metadata).filter(([, v]) => v !== undefined && v !== null);
  if (entries.length === 0) return <p className="text-xs text-muted-foreground">No metadata recorded.</p>;
  return (
    <dl className="space-y-2.5">
      {entries.map(([key, value]) => (
        <div key={key} className="flex items-start justify-between gap-4 border-b border-border/40 pb-2">
          <dt className="shrink-0 font-mono text-[11px] text-muted-foreground">{key}</dt>
          <dd className="min-w-0 text-right">
            {typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? (
              <span className="font-mono text-[11px] break-all text-slate-300">{String(value)}</span>
            ) : (
              <pre className="max-h-64 overflow-auto rounded-lg bg-[#0b1322] p-2.5 text-left font-mono text-[10.5px] text-slate-300">
                {JSON.stringify(value, null, 2)}
              </pre>
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}
