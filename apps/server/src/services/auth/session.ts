/**
 * Sessions (decision #41).
 *
 * The cookie carries a 32-byte random token; the DB stores only its SHA-256.
 * A leaked database cannot be replayed as a login. Expiry is checked on every
 * lookup; logout deletes the row.
 */
import { createHash, randomBytes } from "node:crypto";
import { and, eq, lt } from "drizzle-orm";
import { schema, type Db } from "../../db/index.js";

export const SESSION_COOKIE = "sailor_session";

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function createSession(
  db: Db,
  userId: string,
  ttlDays: number,
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000);
  await db.insert(schema.sessions).values({ tokenHash: hashToken(token), userId, expiresAt });
  return { token, expiresAt };
}

export async function sessionUser(db: Db, token: string | undefined) {
  if (!token) return undefined;
  const [row] = await db
    .select({ user: schema.users, expiresAt: schema.sessions.expiresAt })
    .from(schema.sessions)
    .innerJoin(schema.users, eq(schema.users.id, schema.sessions.userId))
    .where(eq(schema.sessions.tokenHash, hashToken(token)));
  if (!row) return undefined;
  if (row.expiresAt.getTime() < Date.now()) return undefined;
  return row.user;
}

export async function deleteSession(db: Db, token: string): Promise<void> {
  await db.delete(schema.sessions).where(eq(schema.sessions.tokenHash, hashToken(token)));
}

/** Hygiene on successful login; expired rows already fail lookup. */
export async function deleteExpiredSessions(db: Db, userId: string): Promise<void> {
  await db
    .delete(schema.sessions)
    .where(and(eq(schema.sessions.userId, userId), lt(schema.sessions.expiresAt, new Date())));
}
