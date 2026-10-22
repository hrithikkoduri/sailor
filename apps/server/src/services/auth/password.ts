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

/**
 * Cheap signup heuristics — no SMTP, no DNS, no third-party service.
 *
 * This is not ownership verification: it only rejects placeholder and
 * throwaway domains that are almost certainly not a real account. A real
 * "click the link" flow needs an email provider; that is deliberately out of
 * core for now. GitHub sign-in already carries GitHub's verified email.
 */
const PLACEHOLDER_DOMAINS = new Set([
  "example.com",
  "example.org",
  "example.net",
  "example.edu",
  "localhost",
  "invalid",
  "test",
]);

const DISPOSABLE_DOMAINS = new Set([
  "10minutemail.com",
  "dispostable.com",
  "fakeinbox.com",
  "getnada.com",
  "guerrillamail.com",
  "maildrop.cc",
  "mailinator.com",
  "mytemp.email",
  "sharklasers.com",
  "spam4.me",
  "temp-mail.org",
  "tempmail.com",
  "throwawaymail.com",
  "trashmail.com",
  "yopmail.com",
]);

export function emailProblem(email: string): string | undefined {
  const at = email.lastIndexOf("@");
  if (at <= 0 || at === email.length - 1) return "enter a valid email address";
  const domain = email.slice(at + 1);
  if (domain.includes("..") || /^[0-9.]+$/.test(domain))
    return "enter a valid email address";
  if (
    PLACEHOLDER_DOMAINS.has(domain) ||
    domain.endsWith(".test") ||
    domain.endsWith(".invalid") ||
    domain.endsWith(".localhost")
  )
    return "use a real email address";
  if (
    DISPOSABLE_DOMAINS.has(domain) ||
    [...DISPOSABLE_DOMAINS].some((d) => domain.endsWith(`.${d}`))
  )
    return "use a permanent email address instead of a disposable one";
  return undefined;
}
