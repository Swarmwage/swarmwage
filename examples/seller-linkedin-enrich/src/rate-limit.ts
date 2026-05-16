// © 2026 Swarmwage. MIT.
// Per-IP sliding-window rate limiter for the seller's /hire endpoint.
//
// Defends the upstream API quota (and the seller's account costs) from
// trivial flood attacks. Mounted BEFORE the x402 paymentMiddleware so a
// flood is rejected without ever invoking the facilitator. State is in
// memory and per-process; for multi-replica deployments swap for a Redis
// or Postgres-backed limiter.

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

  check(key: string): { allowed: boolean; retryAfterMs: number } {
    const now = Date.now();
    const cutoff = now - this.windowMs;
    const existing = this.windows.get(key);
    const trimmed = existing ? existing.filter((t) => t > cutoff) : [];
    if (trimmed.length >= this.limit) {
      this.windows.set(key, trimmed);
      const retryAfterMs = Math.max(1, trimmed[0]! + this.windowMs - now);
      return { allowed: false, retryAfterMs };
    }
    trimmed.push(now);
    this.windows.set(key, trimmed);
    return { allowed: true, retryAfterMs: 0 };
  }

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
}

export function clientIp(c: Context): string {
  const xff = c.req.header("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0];
    if (first && first.trim().length > 0) return first.trim();
  }
  const realIp = c.req.header("x-real-ip");
  if (realIp && realIp.trim().length > 0) return realIp.trim();
  const env = c.env as
    | { incoming?: { socket?: { remoteAddress?: string } } }
    | undefined;
  const remote = env?.incoming?.socket?.remoteAddress;
  return remote && remote.length > 0 ? remote : "unknown";
}

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
        { error: "Too many requests", retry_after_seconds: retryAfterSec },
        429,
      );
    }
    await next();
  };
}
