/**
 * Account secrets — encrypted at rest, write-only at the API boundary.
 *
 * AES-256-GCM with a deployment key (`SAILOR_SECRET_KEY`, 32 bytes base64) that
 * is deliberately NOT in the database: a database dump alone cannot decrypt
 * anything. The AAD binds each ciphertext to its owner and name, so moving a
 * row (or replaying a value under another name) fails authentication.
 *
 * Plaintext leaves this module only through `getSecretValue`, which the run
 * executor calls for an approved tool call. It is never returned by an HTTP
 * handler, never logged, and never stored in `events` or traces.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { schema, type Db } from "../../db/index.js";

export interface SecretMetadata {
  id: string;
  name: string;
  envVar: string;
  createdAt: Date;
  updatedAt: Date;
  lastUsedAt: Date | null;
}

/** AAD keeps a ciphertext bound to one owner + name. */
const aad = (userId: string, name: string) => Buffer.from(`${userId}:${name}`, "utf8");

export function encryptionKey(env: NodeJS.ProcessEnv = process.env): Buffer {
  const raw = env.SAILOR_SECRET_KEY;
  if (!raw) {
    throw new Error(
      "SAILOR_SECRET_KEY is not set — generate one with `openssl rand -base64 32` " +
        "and keep it out of the database (it is the only thing protecting stored secrets)",
    );
  }
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) throw new Error("SAILOR_SECRET_KEY must be 32 bytes, base64-encoded");
  return key;
}

export function encryptSecret(
  key: Buffer,
  userId: string,
  name: string,
  value: string,
): { ciphertext: string; iv: string; tag: string } {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad(userId, name));
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  };
}

export function decryptSecret(
  key: Buffer,
  userId: string,
  name: string,
  parts: { ciphertext: string; iv: string; tag: string },
): string {
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(parts.iv, "base64"));
  decipher.setAAD(aad(userId, name));
  decipher.setAuthTag(Buffer.from(parts.tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(parts.ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

export async function listSecrets(db: Db, userId: string): Promise<SecretMetadata[]> {
  const rows = await db
    .select({
      id: schema.secrets.id,
      name: schema.secrets.name,
      envVar: schema.secrets.envVar,
      createdAt: schema.secrets.createdAt,
      updatedAt: schema.secrets.updatedAt,
      lastUsedAt: schema.secrets.lastUsedAt,
    })
    .from(schema.secrets)
    .where(eq(schema.secrets.userId, userId))
    .orderBy(schema.secrets.name);
  return rows;
}

/** Create or replace one secret. The caller owns authorization. */
export async function putSecret(
  db: Db,
  userId: string,
  input: { name: string; envVar: string; value: string },
): Promise<SecretMetadata> {
  const key = encryptionKey();
  const parts = encryptSecret(key, userId, input.name, input.value);
  const [row] = await db
    .insert(schema.secrets)
    .values({ userId, name: input.name, envVar: input.envVar, ...parts })
    .onConflictDoUpdate({
      target: [schema.secrets.userId, schema.secrets.name],
      set: { envVar: input.envVar, ...parts, updatedAt: new Date() },
    })
    .returning({
      id: schema.secrets.id,
      name: schema.secrets.name,
      envVar: schema.secrets.envVar,
      createdAt: schema.secrets.createdAt,
      updatedAt: schema.secrets.updatedAt,
      lastUsedAt: schema.secrets.lastUsedAt,
    });
  return row!;
}

export async function deleteSecret(db: Db, userId: string, id: string): Promise<boolean> {
  const removed = await db
    .delete(schema.secrets)
    .where(and(eq(schema.secrets.id, id), eq(schema.secrets.userId, userId)))
    .returning({ id: schema.secrets.id });
  return removed.length > 0;
}

/** Server-side only: the plaintext for one approved secret. */
export async function getSecretValue(
  db: Db,
  userId: string,
  name: string,
): Promise<{ envVar: string; value: string } | undefined> {
  const key = encryptionKey();
  const [row] = await db
    .select()
    .from(schema.secrets)
    .where(and(eq(schema.secrets.userId, userId), eq(schema.secrets.name, name)));
  if (!row) return undefined;
  const value = decryptSecret(key, userId, name, row);
  await db
    .update(schema.secrets)
    .set({ lastUsedAt: new Date() })
    .where(eq(schema.secrets.id, row.id));
  return { envVar: row.envVar, value };
}

/** Server-side only: every plaintext value, for redaction and publication scans.
 *
 * This does not mark `lastUsedAt` — no tool ran. It decrypts only rows that
 * exist; a deployment with no secrets never needs the key for this path.
 */
export async function secretValues(db: Db, userId: string): Promise<string[]> {
  const rows = await db.select().from(schema.secrets).where(eq(schema.secrets.userId, userId));
  if (rows.length === 0) return [];
  const key = encryptionKey();
  return rows.map((row) => decryptSecret(key, userId, row.name, row));
}

/** Names and env vars only — for prompts and the approval UI. */
export async function secretCatalog(
  db: Db,
  userId: string,
): Promise<Array<{ name: string; envVar: string }>> {
  return (await listSecrets(db, userId)).map(({ name, envVar }) => ({ name, envVar }));
}
