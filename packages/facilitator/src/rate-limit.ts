// Swarmwage Facilitator — in-memory sliding-window rate limiter
// License: BUSL-1.1
//
// Defends the gas bankroll against trivial flood attacks. The /settle
// endpoint pays real ETH gas every time it broadcasts; without a rate
// limit, any client could chain valid authorizations and drain the
// bankroll at the cost of one well-formed signature per second. Two
// dimensions are limited:
//
//   1. Per source IP (read from X-Forwarded-For when present, falling
//      back to the raw socket address). Catches naive flood attacks.
//   2. Per buyer EVM address (`auth.from`). Catches the case where one
//      buyer rotates IPs (proxy / VPN) but keeps signing with the same
//      key — they still hit one bucket.
//
// State is in-memory and per-process. For multi-process deployments
// behind a load balancer this is approximate (the effective limit is
// `limit × replicas`); good enough at Day-7 scale, swap for a Redis
// or Postgres-backed limiter when traffic justifies it.

import type { Context, MiddlewareHandler } from "hono";

export interface RateLimiterOptions {
  /** Maximum requests permitted within the window. */
  limit: number;
  /** Sliding window length in milliseconds. */
  windowMs: number;
}

export class SlidingWindowLimiter {
  private readonly windows = new Map<string, number[]>();
  private readonly limit: number;
  private readonly windowMs: number;

  constructor(opts: RateLimiterOptions) {
    if (opts.limit < 1 || !Number.isFinite(opts.limit)) {
      throw new Error("RateLimiter: limit must be a positive integer");
    }
    if (opts.windowMs < 1 || !Number.isFinite(opts.windowMs)) {
      throw new Error("RateLimiter: windowMs must be a positive integer");
    }
    this.limit = Math.floor(opts.limit);
    this.windowMs = Math.floor(opts.windowMs);
  }

  /**
   * Returns `{ allowed: true }` when the request fits within the window
   * (and records its timestamp). Returns `{ allowed: false, retryAfterMs }`
   * when the bucket is full.
   */
  check(key: string): { allowed: boolean; retryAfterMs: number } {
    const now = Date.now();
    const cutoff = now - this.windowMs;
    const existing = this.windows.get(key);
    const trimmed = existing
      ? existing.filter((t) => t > cutoff)
      : [];

    if (trimmed.length >= this.limit) {
      // Persist the trimmed view so the next call doesn't re-walk the
      // same expired entries. retryAfterMs is the time until the oldest
      // entry in the window falls out.
      this.windows.set(key, trimmed);
      const retryAfterMs = Math.max(1, trimmed[0]! + this.windowMs - now);
      return { allowed: false, retryAfterMs };
    }

    trimmed.push(now);
    this.windows.set(key, trimmed);
    return { allowed: true, retryAfterMs: 0 };
  }

  /**
   * Periodic garbage collection — prune empty windows so a long-running
   * process can survive bursts of distinct keys (e.g. a Tor exit node)
   * without unbounded Map growth. Safe to call from a setInterval.
   */
  gc(): void {
    const cutoff = Date.now() - this.windowMs;
    for (const [key, ts] of this.windows.entries()) {
      const trimmed = ts.filter((t) => t > cutoff);
      if (trimmed.length === 0) {
        this.windows.delete(key);
      } else if (trimmed.length !== ts.length) {
        this.windows.set(key, trimmed);
      }
    }
  }

  /** Number of distinct keys currently tracked. Test-only. */
  size(): number {
    return this.windows.size;
  }
}

/**
 * Best-effort client-IP extraction. Order:
 *   1. First entry in `X-Forwarded-For` (set by reverse proxies).
 *   2. `X-Real-IP` (set by some proxies as a single value).
 *   3. The raw remote socket address from the Node adapter, when present.
 *   4. Literal `"unknown"` — the limiter then groups every unidentifiable
 *      caller into a single bucket, which is the safer failure mode (rate
 *      limit too aggressive for misconfigured deploys, never too lax).
 */
export function clientIp(c: Context): string {
  const xff = c.req.header("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0];
    if (first && first.trim().length > 0) {
      return first.trim();
    }
  }
  const realIp = c.req.header("x-real-ip");
  if (realIp && realIp.trim().length > 0) {
    return realIp.trim();
  }
  // The Node adapter exposes the original IncomingMessage on c.env.incoming.
  // The exact shape varies across adapters; defensively narrow it.
  const env = c.env as
    | { incoming?: { socket?: { remoteAddress?: string } } }
    | undefined;
  const remote = env?.incoming?.socket?.remoteAddress;
  return remote && remote.length > 0 ? remote : "unknown";
}

/**
 * Hono middleware that rate-limits requests by the key returned from
 * `getKey(c)`. On rejection, returns 429 with a `Retry-After` header
 * (seconds, per RFC 7231) and a JSON error body.
 */
export function rateLimit(
  limiter: SlidingWindowLimiter,
  getKey: (c: Context) => string,
): MiddlewareHandler {
  return async (c, next) => {
    const key = getKey(c);
    const result = limiter.check(key);
    if (!result.allowed) {
      const retryAfterSec = Math.max(1, Math.ceil(result.retryAfterMs / 1000));
      c.header("Retry-After", String(retryAfterSec));
      return c.json(
        {
          error: "Too many requests",
          retry_after_seconds: retryAfterSec,
        },
        429,
      );
    }
    await next();
  };
}
