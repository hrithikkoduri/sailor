import { useCallback, useState } from "react";
import { useNavigate } from "react-router-dom";
import { getTraces, type TraceRow } from "@/features/threads/api";
import { usePoll } from "@/hooks/use-poll";
import { ApiError } from "@/utils/api-client";

/** Page state and polling for the trace table; the page owns only view state. */
export function useTraces() {
  const navigate = useNavigate();
  const [page, setPage] = useState(0);
  const [rows, setRows] = useState<TraceRow[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const data = await getTraces(page);
      setRows(data.traces);
      setHasMore(data.hasMore);
      setError("");
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) navigate("/login");
      else setError("Traces couldn't be loaded. Try again.");
    }
  }, [page, navigate]);

  usePoll(load, 10000);

  const goToPage = useCallback((next: number) => {
    setRows(null);
    setPage(next);
  }, []);

  return { page, rows, hasMore, error, goToPage };
}
