/** Chat surface: say something; force a pending event in. */
import { api } from "@/utils/api-client";

/** Enter-send: while a run is busy the server queues it behind the turn. */
export const postMessage = (threadId: string, text: string) =>
  api<{
    ok: boolean;
    eventId: string;
    interjected: boolean;
    runId: string | null;
  }>(`/api/threads/${threadId}/messages`, {
    method: "POST",
    body: JSON.stringify({ text }),
  });

/** Explicit override (decision #28): the pending event becomes the next turn. */
export const interjectEvent = (eventId: string) =>
  api<{ ok: boolean; action: string }>(`/api/events/${eventId}/interject`, {
    method: "POST",
  });
