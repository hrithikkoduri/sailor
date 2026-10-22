import type { TraceRow } from "@/features/threads/api";

export const TRACE_OUTCOMES = [
  "all",
  "running",
  "queued",
  "succeeded",
  "failed",
  "paused",
  "cancelled",
  "budget_exhausted",
] as const;

export function outcomeLabel(value: string): string {
  return value === "all" ? "All outcomes" : value.replace(/_/g, " ");
}

/** Pure filter: outcome, then the free-text fields shown in the table. */
export function filterTraces(rows: TraceRow[], status: string, query: string): TraceRow[] {
  const needle = query.trim().toLowerCase();
  return rows.filter((row) => {
    if (status !== "all" && row.status !== status) return false;
    if (!needle) return true;
    return `${row.title ?? ""} ${row.task ?? ""} ${row.repo} ${row.id}`
      .toLowerCase()
      .includes(needle);
  });
}

export function durationLabel(startedAt: string | null, finishedAt: string | null): string {
  if (!startedAt) return "—";
  const seconds = Math.max(
    0,
    Math.round(
      (new Date(finishedAt ?? Date.now()).getTime() - new Date(startedAt).getTime()) / 1000,
    ),
  );
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
