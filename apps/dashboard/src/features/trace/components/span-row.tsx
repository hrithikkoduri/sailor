import {
  Bot,
  ChevronDown,
  ChevronRight,
  Circle,
  CircleX,
  GitCommitHorizontal,
  Layers2,
  Wrench,
} from "lucide-react";
import type { SpanNode } from "../build-tree";
import { cn } from "@/utils/cn";
import { fmtTokens } from "@/utils/format";

const ICON = {
  run: Layers2,
  phase: Circle,
  llm: Bot,
  tool: Wrench,
  note: GitCommitHorizontal,
};
export function SpanRow({
  node,
  depth = 0,
  window,
  selectedId,
  collapsed,
  query,
  onSelect,
  onToggle,
}: {
  node: SpanNode;
  depth?: number;
  window: { start: number; end: number };
  selectedId: string | null;
  collapsed: Set<string>;
  query: string;
  onSelect: (id: string) => void;
  onToggle: (id: string) => void;
}) {
  const matches = (n: SpanNode): boolean =>
    n.name.toLowerCase().includes(query) || n.children.some(matches);
  if (query && !matches(node)) return null;
  const failed = node.status === "fail";
  const Icon = failed ? CircleX : ICON[node.kind];
  const expanded = !!query || !collapsed.has(node.id);
  const tokens = (node.tokensIn ?? 0) + (node.tokensOut ?? 0);
  const total = Math.max(1, window.end - window.start);
  const left = Math.max(
    0,
    Math.min(99, ((node.startMs - window.start) / total) * 100),
  );
  const width = Math.min(
    100 - left,
    Math.max(2, ((node.durationMs ?? 0) / total) * 100),
  );
  return (
    <li>
      <div
        data-span-status={node.status}
        className={cn(
          "group flex min-h-10 items-center gap-1 border-l-2 pr-3 text-xs transition-colors",
          selectedId === node.id
            ? "border-selection-foreground bg-selection text-selection-foreground"
            : "border-transparent hover:bg-muted/60",
          failed && "bg-destructive/2",
        )}
        style={{ paddingLeft: 8 + depth * 14 }}
      >
        {node.children.length ? (
          <button
            aria-label={`${expanded ? "Collapse" : "Expand"} ${node.name}`}
            aria-expanded={expanded}
            onClick={() => onToggle(node.id)}
            className="flex size-5 shrink-0 items-center justify-center rounded hover:bg-accent"
          >
            {expanded ? (
              <ChevronDown className="size-3" />
            ) : (
              <ChevronRight className="size-3" />
            )}
          </button>
        ) : (
          <span className="w-5 shrink-0" />
        )}
        <button
          onClick={() => onSelect(node.id)}
          aria-pressed={selectedId === node.id}
          className="flex min-w-0 flex-1 items-center gap-2 py-2 text-left"
        >
          <Icon
            aria-hidden
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground",
              failed && "text-destructive",
            )}
          />
          <span
            className={cn(
              "min-w-0 flex-1 truncate",
              node.kind === "run" && "font-medium",
              failed && "font-medium text-destructive",
            )}
          >
            {node.name
              .replace("agent · step", "Model call")
              .replace("phase · ", "")}
          </span>
          {failed && (
            <span className="shrink-0 text-[10px] font-medium text-destructive">
              Failed
            </span>
          )}
          <span
            className={cn(
              "size-1 shrink-0 rounded-full bg-input",
              node.status === "ok" && "bg-success",
              node.status === "fail" && "bg-destructive",
              node.status === "running" && "animate-pulse bg-warning",
            )}
            title={node.status}
          />
          <span className="hidden w-12 shrink-0 text-right font-mono text-[10px] text-muted-foreground sm:block">
            {tokens ? fmtTokens(tokens) : "—"}
          </span>
          <span className="w-12 shrink-0 text-right font-mono text-[10px] text-muted-foreground">
            {node.estimated ? "~" : ""}
            {((node.durationMs ?? 0) / 1000).toFixed(1)}s
          </span>
          <span className="relative ml-1 hidden h-1 w-14 shrink-0 rounded-full bg-muted lg:block">
            <span
              className={cn(
                "absolute h-full rounded-full bg-muted-foreground/50",
                failed && "bg-destructive",
              )}
              style={{ left: `${left}%`, width: `${width}%` }}
            />
          </span>
        </button>
      </div>
      {expanded && !!node.children.length && (
        <ul className="relative">
          {node.children.map((child) => (
            <SpanRow
              key={child.id}
              node={child}
              depth={depth + 1}
              window={window}
              selectedId={selectedId}
              collapsed={collapsed}
              query={query}
              onSelect={onSelect}
              onToggle={onToggle}
            />
          ))}
        </ul>
      )}
    </li>
  );
}
