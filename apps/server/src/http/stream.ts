/**
 * stream.ts — the live-update fanout (BUILD_PLAN step 17b).
 *
 * Two directions, one channel:
 *   worker process → Redis pub/sub → serve's subscriber → StreamHub → SSE clients
 *   serve-internal writes (webhooks, API actions) → StreamHub → SSE clients
 *
 * A message is a NUDGE, never a payload: {"threadId":"…"} means "something
 * about this thread changed — refetch". Clients debounce and re-read the REST
 * endpoints, so the stream can drop or duplicate freely and the UI stays
 * correct (decision #14: state changes update single nodes; Postgres is truth).
 */
import type { Redis } from "ioredis";

export const UPDATES_CHANNEL = "sailor:updates";
/** Live payload channel (step 18): assistant text deltas + activity, unthrottled by DB. */
export const LIVE_CHANNEL = "sailor:live";

export interface StreamHub {
  /** Fan out "thread changed" to every SSE client watching it. */
  notify(threadId: string): void;
  /** Fan out a raw SSE frame (e.g. a `live` payload) to the thread's clients. */
  send(threadId: string, line: string): void;
  /** Register an SSE sender. Returns the unregister function. */
  register(threadId: string, send: (line: string) => void): () => void;
}

export function createStreamHub(): StreamHub {
  const listeners = new Map<string, Set<(line: string) => void>>();
  const fanout = (threadId: string, line: string) => {
    const set = listeners.get(threadId);
    if (!set || set.size === 0) return;
    for (const send of [...set]) send(line);
  };
  return {
    notify(threadId) {
      fanout(threadId, `event: update\ndata: ${JSON.stringify({ threadId })}\n\n`);
    },
    send(threadId, line) {
      fanout(threadId, line);
    },
    register(threadId, send) {
      let set = listeners.get(threadId);
      if (!set) {
        set = new Set();
        listeners.set(threadId, set);
      }
      set.add(send);
      return () => {
        set.delete(send);
        if (set.size === 0) listeners.delete(threadId);
      };
    },
  };
}

/** Worker-side publisher — one shared connection, fire-and-forget. */
export function createThreadNotifier(connection: Redis): (threadId: string) => void {
  return (threadId) => {
    void connection.publish(UPDATES_CHANNEL, JSON.stringify({ threadId })).catch(() => undefined);
  };
}

/** Worker-side live publisher — compact run projections for the chat stream. */
export function createLivePublisher(
  connection: Redis,
): (threadId: string, payload: Record<string, unknown>) => void {
  return (threadId, payload) => {
    void connection.publish(LIVE_CHANNEL, JSON.stringify({ threadId, ...payload })).catch(() => undefined);
  };
}
