import { Link } from "react-router-dom";
import { Activity, ArrowUpRight } from "lucide-react";
import { repositoryLabel, type TraceRow } from "@/features/threads/api";
import { StatusPill } from "@/elements/status-pill";
import { timeAgo } from "@/utils/format";
import { durationLabel } from "../../traces";

const COLUMNS = ["Run / thread", "Outcome", "Steps", "Tokens", "Cost", "Duration", "Started"];

export function TracesTable({
  rows,
  loading,
  filtered,
}: {
  rows: TraceRow[];
  loading: boolean;
  filtered: boolean;
}) {
  return (
    <div className="overflow-x-auto rounded-xl border border-border bg-card">
      <table className="w-full min-w-[820px] text-left text-sm">
        <thead className="border-b border-border bg-muted/20 text-xs text-muted-foreground">
          <tr>{COLUMNS.map((heading) => <th key={heading} className="px-4 py-3 font-medium first:pl-5">{heading}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} className="border-b border-border last:border-0 hover:bg-muted/30">
              <td className="max-w-80 px-5 py-4">
                <Link to={`/threads/${row.threadId}?run=${row.id}`} className="group block">
                  <span className="flex items-center gap-2 font-medium">
                    <span className="truncate">{row.title ?? row.task?.split("\n")[0] ?? "Agent run"}</span>
                    <ArrowUpRight className="size-3.5 shrink-0 text-muted-foreground" />
                  </span>
                  <span className="mt-1 block truncate text-xs text-muted-foreground">
                    {repositoryLabel(row.repo)} · <span className="font-mono">{row.id.slice(0, 8)}</span>
                  </span>
                </Link>
              </td>
              <td className="px-4 py-4"><StatusPill status={row.status} /></td>
              <td className="px-4 py-4 font-mono text-xs">{row.steps}</td>
              <td className="px-4 py-4 font-mono text-xs">{(row.tokensIn + row.tokensOut).toLocaleString()}</td>
              <td className="px-4 py-4 font-mono text-xs">${Number(row.usd).toFixed(4)}</td>
              <td className="px-4 py-4 text-xs text-muted-foreground">{durationLabel(row.startedAt, row.finishedAt)}</td>
              <td className="px-4 py-4 text-xs text-muted-foreground">{timeAgo(row.startedAt ?? row.createdAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {!rows.length && (
        <div className="px-6 py-16 text-center">
          <Activity className="mx-auto mb-3 size-6 text-muted-foreground" />
          <p className="text-sm font-medium">{loading ? "Loading traces…" : "No traces in this view"}</p>
          <p className="mt-2 text-xs text-muted-foreground">
            {filtered ? "Try another filter or page." : "Start a thread to see its execution here."}
          </p>
        </div>
      )}
    </div>
  );
}
