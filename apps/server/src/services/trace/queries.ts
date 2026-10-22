import { and, desc, eq, isNull, or } from "drizzle-orm";
import { schema, type Db } from "../../db/index.js";

/**
 * Cross-thread run list for the Traces view.
 *
 * Ownership is enforced in the query: an account sees its own threads, plus
 * legacy rows that predate accounts (no user, no installation).
 */
export async function listTraces(
  db: Db,
  userId: string,
  opts: { limit: number; page: number },
) {
  const { limit, page } = opts;
  const rows = await db.select({
    id: schema.runs.id, threadId: schema.runs.threadId, title: schema.threads.title,
    repo: schema.threads.repo, task: schema.runs.task, status: schema.runs.status,
    steps: schema.runs.steps, tokensIn: schema.runs.tokensIn, tokensOut: schema.runs.tokensOut,
    usd: schema.runs.usd, createdAt: schema.runs.createdAt,
    startedAt: schema.runs.startedAt, finishedAt: schema.runs.finishedAt,
  }).from(schema.runs).innerJoin(schema.threads, eq(schema.runs.threadId, schema.threads.id))
    .where(or(eq(schema.threads.userId, userId), and(isNull(schema.threads.userId), isNull(schema.threads.installationId))))
    .orderBy(desc(schema.runs.createdAt), desc(schema.runs.id)).limit(limit + 1).offset(page * limit);
  return { traces: rows.slice(0, limit), hasMore: rows.length > limit, page };
}
