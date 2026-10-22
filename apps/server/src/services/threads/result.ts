/**
 * Shared result shape for thread use cases.
 *
 * A use case returns its value or a `ServiceFailure`; the HTTP layer maps that
 * to a status code. Keeping the type here lets each use-case module stay small
 * and lets callers import nothing but this file.
 */
import { and, eq, inArray } from "drizzle-orm";
import { schema, type Db } from "../../db/index.js";

export interface ServiceFailure {
  error: string;
  status: 400 | 403 | 404 | 409;
}

export interface Notifier {
  notify(threadId: string): void;
}

export function isFailure(value: unknown): value is ServiceFailure {
  return typeof value === "object" && value !== null && "error" in value && "status" in value;
}

export const CLOSED_STATES = ["merged", "closed", "abandoned"];

/** The thread, but only if this user owns it. */
export async function ownedThread(db: Db, userId: string, threadId: string) {
  const [thread] = await db.select().from(schema.threads)
    .where(and(eq(schema.threads.id, threadId), eq(schema.threads.userId, userId)));
  return thread;
}

export async function hasActiveRun(db: Db, threadId: string) {
  const rows = await db.select({ id: schema.runs.id }).from(schema.runs)
    .where(and(eq(schema.runs.threadId, threadId), inArray(schema.runs.status, ["queued", "running"])));
  return rows.length > 0;
}
