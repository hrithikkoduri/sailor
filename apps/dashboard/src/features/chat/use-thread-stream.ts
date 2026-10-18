import { useEffect, useRef, useState } from "react";
import { applyLiveEvent, type LiveEvent, type LiveState } from "./live";

/** SSE is low-latency; bounded reconciliation is the recovery path, not a refresh button. */
export function useThreadStream(
  threadId: string,
  onUpdate: () => void,
  active = false,
) {
  const [live, setLive] = useState<LiveState | null>(null);
  const callback = useRef(onUpdate);
  callback.current = onUpdate;
  useEffect(() => {
    setLive(null);
    const es = new EventSource(`/api/threads/${threadId}/stream`);
    let timer: number | undefined;
    const schedule = () => {
      // Throttle, don't trailing-debounce forever under a continuous stream.
      if (timer !== undefined) return;
      timer = window.setTimeout(() => {
        timer = undefined;
        callback.current();
      }, 150);
    };
    es.addEventListener("open", () => callback.current());
    es.addEventListener("hello", () => callback.current());
    es.addEventListener("update", schedule);
    es.addEventListener("live", (ev) => {
      try {
        const event = JSON.parse((ev as MessageEvent).data) as LiveEvent;
        if (event.threadId !== threadId || !event.runId) return;
        setLive((prev) => applyLiveEvent(prev, event));
        if (["run_finished", "assistant_done", "error"].includes(event.kind))
          schedule();
      } catch {
        /* ignore malformed frames; the next persisted read recovers */
      }
    });
    return () => {
      window.clearTimeout(timer);
      es.close();
    };
  }, [threadId]);
  useEffect(() => {
    const interval = window.setInterval(
      () => callback.current(),
      active ? 2000 : 10000,
    );
    const visible = () => {
      if (!document.hidden) callback.current();
    };
    document.addEventListener("visibilitychange", visible);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [threadId, active]);
  return { live, setLive };
}
