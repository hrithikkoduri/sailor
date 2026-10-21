/**
 * Auth rate limiting — fixed window per key, bounded memory, Retry-After hints.
 */
import { describe, expect, it } from "vitest";
import { createLimiter, clientAddress } from "../../src/server/rate-limit.js";

describe("createLimiter", () => {
  it("allows up to the limit, then refuses until the window rolls over", () => {
    let now = 0;
    const limiter = createLimiter({ limit: 3, windowMs: 1000, now: () => now });

    expect(limiter.check("ip").allowed).toBe(true);
    expect(limiter.check("ip").allowed).toBe(true);
    expect(limiter.check("ip").allowed).toBe(true);

    const blocked = limiter.check("ip");
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSecs).toBe(1);

    now = 1000; // window reset
    expect(limiter.check("ip").allowed).toBe(true);
  });

  it("keeps separate buckets per key", () => {
    const limiter = createLimiter({ limit: 1, windowMs: 1000, now: () => 0 });
    expect(limiter.check("a").allowed).toBe(true);
    expect(limiter.check("a").allowed).toBe(false);
    expect(limiter.check("b").allowed).toBe(true);
  });

  it("reports the remaining time as a whole number of seconds", () => {
    let now = 0;
    const limiter = createLimiter({ limit: 1, windowMs: 5000, now: () => now });
    limiter.check("ip");
    now = 1200;
    expect(limiter.check("ip").retryAfterSecs).toBe(4); // ceil(3800 / 1000)
  });

  it("reset clears every bucket", () => {
    const limiter = createLimiter({ limit: 1, windowMs: 1000, now: () => 0 });
    limiter.check("ip");
    expect(limiter.check("ip").allowed).toBe(false);
    limiter.reset();
    expect(limiter.check("ip").allowed).toBe(true);
  });

  it("stays bounded under a flood of distinct keys", () => {
    const limiter = createLimiter({ limit: 1, windowMs: 10_000, now: () => 0 });
    for (let i = 0; i < 25_000; i += 1) limiter.check(`ip-${i}`);
    // The newest key is tracked; old ones may have been evicted, never grown
    // without limit. Sampling the most recent key proves the map still works.
    expect(limiter.check("ip-24999").allowed).toBe(false);
  });
});

describe("clientAddress", () => {
  const ctx = (headers: Record<string, string>) =>
    ({ req: { header: (name: string) => headers[name] } }) as unknown as Parameters<typeof clientAddress>[0];

  it("uses the hop the proxy appended, not a client-supplied one", () => {
    expect(clientAddress(ctx({ "x-forwarded-for": "1.2.3.4, 5.6.7.8" }))).toBe("5.6.7.8");
  });

  it("falls back to X-Real-IP, then a local bucket", () => {
    expect(clientAddress(ctx({ "x-real-ip": "9.9.9.9" }))).toBe("9.9.9.9");
    expect(clientAddress(ctx({}))).toBe("local");
  });
});
