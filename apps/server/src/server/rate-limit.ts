/**
 * In-process rate limiting for the auth surface.
 *
 * Single-instance, fixed window, bounded memory: enough to stop credential
 * stuffing against one process. A multi-instance deployment should move this to
 * Redis (the queue connection is already there) — the interface stays the same.
 *
 * Behind the ALB the client address arrives as X-Forwarded-For; the ALB
 * APPENDS the address it saw, so the LAST hop is the trustworthy one — earlier
 * entries are whatever the client sent and must not become the bucket key.
 * Locally there is no proxy, so "local" is a single bucket (fine for
 * development; production always has the header).
 */
import type { Context, MiddlewareHandler } from "hono";

export interface RateLimitResult {
  allowed: boolean;
  /** Seconds until the window resets — sent as Retry-After. */
  retryAfterSecs: number;
}

export interface Limiter {
  check(key: string): RateLimitResult;
  reset(): void;
}

/** Bounded so a spoofed-header flood cannot grow the map without limit. */
const MAX_KEYS = 20_000;

export function createLimiter(opts: {
  limit: number;
  windowMs: number;
  now?: () => number;
}): Limiter {
  const now = opts.now ?? (() => Date.now());
  const hits = new Map<string, { count: number; resetAt: number }>();
  return {
    check(key) {
      const at = now();
      const entry = hits.get(key);
      if (!entry || entry.resetAt <= at) {
        if (hits.size >= MAX_KEYS) {
          // Drop the oldest-expiring quarter rather than growing unbounded.
          for (const [k, v] of [...hits].sort((a, b) => a[1].resetAt - b[1].resetAt).slice(0, MAX_KEYS / 4))
            hits.delete(k);
        }
        hits.set(key, { count: 1, resetAt: at + opts.windowMs });
        return { allowed: true, retryAfterSecs: 0 };
      }
      entry.count += 1;
      if (entry.count > opts.limit)
        return { allowed: false, retryAfterSecs: Math.max(1, Math.ceil((entry.resetAt - at) / 1000)) };
      return { allowed: true, retryAfterSecs: 0 };
    },
    reset() {
      hits.clear();
    },
  };
}

/**
 * Middleware form: counts one hit per client address per scope and answers 429
 * with Retry-After once the limit is exceeded.
 */
export function rateLimit(limiter: Limiter, scope: string): MiddlewareHandler {
  return async (c, next) => {
    const result = limiter.check(`${scope}:${clientAddress(c)}`);
    if (!result.allowed) {
      c.header("retry-after", String(result.retryAfterSecs));
      return c.json({ error: "too many attempts — try again shortly" }, 429);
    }
    await next();
  };
}

/** Last X-Forwarded-For hop (appended by the ALB), else X-Real-IP, else local. */
export function clientAddress(c: Context): string {
  const forwarded = c.req.header("x-forwarded-for");
  if (forwarded) {
    const hops = forwarded.split(",").map((hop) => hop.trim()).filter(Boolean);
    const last = hops[hops.length - 1];
    if (last) return last;
  }
  return c.req.header("x-real-ip")?.trim() || "local";
}