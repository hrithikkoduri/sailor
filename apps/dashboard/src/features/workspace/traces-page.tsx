import { useMemo, useState } from "react";
import { WorkspacePage } from "./workspace-page";
import { TracesFilters } from "./components/traces-view/traces-filters";
import { TracesPagination } from "./components/traces-view/traces-pagination";
import { TracesTable } from "./components/traces-view/traces-table";
import { filterTraces } from "./traces";
import { useTraces } from "./use-traces";

export function TracesPage() {
  const { page, rows, hasMore, error, goToPage } = useTraces();
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const visible = useMemo(() => filterTraces(rows ?? [], status, query), [rows, status, query]);

  return (
    <WorkspacePage eyebrow="The evidence, not just the answer" title="See how the work happened." description="A run-by-run view of actions, tokens, timing, and outcomes. Open any trace to inspect the full execution.">
      <TracesFilters status={status} query={query} onStatusChange={setStatus} onQueryChange={setQuery} />
      {error && <p role="alert" className="mb-3 text-sm text-destructive">{error}</p>}
      <TracesTable rows={visible} loading={rows === null} filtered={Boolean(query.trim()) || status !== "all"} />
      <TracesPagination
        page={page}
        hasMore={hasMore}
        onPrevious={() => goToPage(page - 1)}
        onNext={() => goToPage(page + 1)}
      />
    </WorkspacePage>
  );
}
