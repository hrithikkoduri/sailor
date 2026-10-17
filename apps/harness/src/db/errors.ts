/**
 * Postgres error helpers.
 */

/**
 * True when an error is a unique-constraint violation (SQLSTATE 23505),
 * looking through wrapper chains (drizzle wraps driver errors).
 */
export function isUniqueViolation(err: unknown): boolean {
  for (let e: unknown = err; e instanceof Error; e = e.cause) {
    if ((e as { code?: unknown }).code === "23505") return true;
    if (/duplicate key/i.test(e.message)) return true;
  }
  return false;
}
