// Swarmwage Registry — in-process token-bucket rate limiter
// License: BUSL-1.1
//
// Defense-in-depth against floods on unauthenticated endpoints
// (/telemetry, /v1/rate, /v1/claim). Token-bucket per client IP. Single
// process — does not coordinate across replicas. For Day-7 single-host
// posture this is sufficient; once we scale horizontally, swap to
// Cloudflare Turnstile / upstream WAF / a Redis bucket.

import type { MiddlewareHandler } from "hono";

interface Bucket {
  tokens: number;
  updatedAt: number;
}

interface RateLimitOptions {
  /** Tokens added per second per client. */
  refillPerSec: number;
  /** Max tokens a client can hold. Equals burst size. */
  burst: number;
  /** Identifier function — defaults to a best-effort client IP. */
  keyOf?: (c: Parameters<MiddlewareHandler>[0]) => string;
}

const DEFAULT_KEY = (
  c: Parameters<MiddlewareHandler>[0],
): string =>
  c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
  c.req.header("x-real-ip") ||
  c.req.header("cf-connecting-ip") ||
  "unknown";

export function rateLimit(opts: RateLimitOptions): MiddlewareHandler {
  const buckets = new Map<string, Bucket>();
  const keyOf = opts.keyOf ?? DEFAULT_KEY;

  // Lazy GC: every 1024 requests, drop buckets unused for >5 minutes.
  let n = 0;
  function maybeGc(now: number) {
    if (++n % 1024 !== 0) return;
    const cutoff = now - 5 * 60 * 1000;
    for (const [k, b] of buckets) {
      if (b.updatedAt < cutoff) buckets.delete(k);
    }
  }

  return async (c, next) => {
    const now = Date.now();
    maybeGc(now);
    const key = keyOf(c);
    const cur = buckets.get(key) ?? { tokens: opts.burst, updatedAt: now };
    const elapsed = (now - cur.updatedAt) / 1000;
    cur.tokens = Math.min(opts.burst, cur.tokens + elapsed * opts.refillPerSec);
    cur.updatedAt = now;
    if (cur.tokens < 1) {
      buckets.set(key, cur);
      const retryAfter = Math.ceil((1 - cur.tokens) / opts.refillPerSec);
      c.header("Retry-After", String(retryAfter));
      return c.json({ error: "Rate limit exceeded" }, 429);
    }
    cur.tokens -= 1;
    buckets.set(key, cur);
    return next();
  };
}
