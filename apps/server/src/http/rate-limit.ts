/**
 * Rate limiting for the auth surface.
 *
 * Two implementations share one interface:
 *   - `createLimiter` — in-process fixed window, bounded memory. Tests and
 *     single-instance development; no external dependency.
 *   - `createRedisLimiter` — fixed window in Redis, shared by every API task.
 *     The deployment uses this so a credential-stuffing burst cannot rotate
 *     across ECS tasks and get a fresh budget from each one.
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
  check(key: string): RateLimitResult | Promise<RateLimitResult>;
  /** Tests only; production limiters expire their own keys. */
  reset?(): void | Promise<void>;
}

/** In-process limiter: still synchronous, so unit tests can read it directly. */
export interface SyncLimiter extends Limiter {
  check(key: string): RateLimitResult;
  reset(): void;
}

/** Bounded so a spoofed-header flood cannot grow the map without limit. */
const MAX_KEYS = 20_000;

export function createLimiter(opts: {
  limit: number;
  windowMs: number;
  now?: () => number;
}): SyncLimiter {
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

/** The subset of ioredis this limiter needs; keeps the unit test Redis-free. */
export interface RedisEvalClient {
  eval(
    script: string,
    numKeys: number,
    ...args: (string | number)[]
  ): Promise<unknown>;
}

/** Increment + first-hit expiry in one atomic script. */
const WINDOW_SCRIPT = `
local count = redis.call("INCR", KEYS[1])
local ttl = redis.call("PTTL", KEYS[1])
if ttl < 0 then
  redis.call("PEXPIRE", KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return {count, ttl}
`;

export function createRedisLimiter(
  redis: RedisEvalClient,
  opts: { limit: number; windowMs: number; prefix?: string },
): Limiter {
  const prefix = opts.prefix ?? "sailor:ratelimit:";
  return {
    async check(key) {
      const raw = await redis.eval(
        WINDOW_SCRIPT,
        1,
        `${prefix}${key}`,
        String(opts.windowMs),
      );
      const [rawCount, rawTtl] = Array.isArray(raw) ? raw : [0, -1];
      const count = Number(rawCount);
      const ttl = Number(rawTtl);
      if (!Number.isFinite(count) || count <= opts.limit)
        return { allowed: true, retryAfterSecs: 0 };
      return {
        allowed: false,
        retryAfterSecs: Math.max(1, Math.ceil((Number.isFinite(ttl) ? ttl : opts.windowMs) / 1000)),
      };
    },
  };
}

/**
 * Middleware form: counts one hit per client address per scope and answers 429
 * with Retry-After once the limit is exceeded.
 *
 * A limiter outage fails OPEN: losing Redis must not lock every user out of
 * sign-in. `/readyz` is the signal that Redis is unhealthy.
 */
export function rateLimit(limiter: Limiter, scope: string): MiddlewareHandler {
  return async (c, next) => {
    let result: RateLimitResult;
    try {
      result = await limiter.check(`${scope}:${clientAddress(c)}`);
    } catch {
      await next();
      return;
    }
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
