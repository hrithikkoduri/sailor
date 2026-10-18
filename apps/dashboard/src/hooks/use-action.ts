/**
 * useAction — the busy/error wrapper around one-shot mutations.
 * One action runs at a time, keyed so the UI can show where the spinner is.
 */
import { useCallback, useState } from "react";
import { ApiError } from "@/utils/api-client";

export function useAction() {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
      return true;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Action failed — try again.");
      return false;
    } finally {
      setBusy(null);
    }
  }, []);

  return { busy, error, run, setError };
}
