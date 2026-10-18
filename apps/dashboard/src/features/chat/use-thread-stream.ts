/**
 * useThreadStream — one SSE connection per thread page.
 *   `update` frames → debounced "something changed" (caller refetches)
 *   `live` frames   → folded into the streaming bubble state
 */
import { useEffect, useRef, useState } from "react";
import { applyLiveEvent, type LiveEvent, type LiveState } from "./live";

export function useThreadStream(threadId: string, onUpdate: () => void) {
  const [live, setLive] = useState<LiveState | null>(null);
  const onUpdateRef = useRef(onUpdate);
  onUpdateRef.current = onUpdate;

  useEffect(() => {
    const es = new EventSource(`/api/threads/${threadId}/stream`);
    let timer: number | undefined;
    es.addEventListener("update", () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => onUpdateRef.current(), 250);
    });
    es.addEventListener("live", (ev) => {
      try {
        setLive((prev) => applyLiveEvent(prev, JSON.parse((ev as MessageEvent).data) as LiveEvent));
      } catch {
        /* malformed frame */
      }
    });
    return () => {
      window.clearTimeout(timer);
      es.close();
    };
  }, [threadId]);

  return { live, setLive };
}
