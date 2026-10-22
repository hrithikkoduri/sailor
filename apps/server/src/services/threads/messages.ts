/** Chat messages: a dashboard message is an inbox event like any other. */
import { eq } from "drizzle-orm";
import { schema, type Db } from "../../db/index.js";
import type { Queues } from "../../queue/index.js";
import { appendEvent, drainInbox, latestActiveRun } from "./inbox.js";
import { isTerminal } from "./state.js";
import type { Notifier, ServiceFailure } from "./result.js";

/** A dashboard message is an inbox event; a busy thread keeps its current run. */
export async function postChatMessage(
  deps: { db: Db; queues: Queues; hub?: Notifier },
  actor: { userId: string; name: string },
  threadId: string,
  rawText: unknown,
): Promise<{ eventId: string; runId: string | null; interjected: false } | ServiceFailure> {
  const [thread] = await deps.db.select().from(schema.threads)
    .where(eq(schema.threads.id, threadId));
  if (!thread || thread.userId !== actor.userId)
    return { error: "thread not found", status: 404 };
  if (isTerminal(thread.state))
    return { error: `thread is ${thread.state} — it takes no more turns`, status: 409 };

  const text = typeof rawText === "string" ? rawText.trim() : "";
  if (!text) return { error: "empty message", status: 400 };
  if (text.length > 8000) return { error: "message too long (8000 characters max)", status: 400 };

  const evt = await appendEvent(deps.db, {
    threadId: thread.id,
    kind: "chat_message",
    payload: { body: text, author: actor.name, via: "dashboard" },
  });

  // Dashboard messages QUEUE. A busy thread keeps its current run — sending is
  // never an implicit cancellation; interjection stays a separate action.
  const active = await latestActiveRun(deps.db, thread.id);
  let runId: string | null = active?.id ?? null;
  if (!active) {
    const run = await drainInbox({ db: deps.db, queues: deps.queues }, thread.id);
    runId = run?.id ?? null;
  }
  deps.hub?.notify(thread.id);
  return { eventId: String(evt.id), runId, interjected: false };
}
