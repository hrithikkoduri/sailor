/**
 * PostgresThreadStore — the durable ThreadStore (decision #17: the package
 * defines the shape, the app supplies the notebook).
 *
 * Backed by the threads row itself: `messages` (jsonb conversation),
 * `summary` (compaction output), `phase` (resume position). Overwrite
 * semantics — every save replaces the thread's state, exactly as the
 * package's ThreadStore contract requires.
 */
import { eq } from "drizzle-orm";
import type { StoredThread, ThreadStore } from "anchor-ai-sdk";
import { schema, type Db } from "../db/index.js";

export class PostgresThreadStore implements ThreadStore {
  constructor(private readonly db: Db) {}

  async load(threadId: string): Promise<StoredThread | undefined> {
    const [row] = await this.db
      .select({
        summary: schema.threads.summary,
        messages: schema.threads.messages,
        phase: schema.threads.phase,
      })
      .from(schema.threads)
      .where(eq(schema.threads.id, threadId));
    if (!row) return undefined;
    return {
      summary: row.summary ?? undefined,
      messages: (row.messages as StoredThread["messages"]) ?? [],
      phase: row.phase ?? undefined,
    };
  }

  async save(threadId: string, thread: StoredThread): Promise<void> {
    await this.db
      .update(schema.threads)
      .set({
        summary: thread.summary ?? null,
        messages: thread.messages as unknown as Record<string, unknown>[],
        phase: thread.phase ?? null,
        updatedAt: new Date(),
      })
      .where(eq(schema.threads.id, threadId));
  }
}
