/**
 * Passwords — argon2id (decision #41).
 *
 * Only ever a hash: the plaintext never leaves this function. argon2id is
 * deliberately slow + memory-hard, so a stolen DB is expensive to crack.
 */
import { hash, verify } from "@node-rs/argon2";

export async function hashPassword(password: string): Promise<string> {
  return hash(password); // @node-rs/argon2 defaults: Argon2id, ~19 MiB, t=2
}

export async function verifyPassword(storedHash: string, password: string): Promise<boolean> {
  try {
    return await verify(storedHash, password);
  } catch {
    return false;
  }
}

export function passwordProblem(password: unknown): string | undefined {
  if (typeof password !== "string" || password.length < 8) return "password must be at least 8 characters";
  return undefined;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(email: unknown): string | undefined {
  if (typeof email !== "string") return undefined;
  const normalized = email.trim().toLowerCase();
  return EMAIL_RE.test(normalized) ? normalized : undefined;
}
