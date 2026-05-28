// Swarmwage Facilitator — in-memory sliding-window rate limiter
// License: BUSL-1.1
//
// Defends the gas bankroll against trivial flood attacks. The /settle
// endpoint pays real ETH gas every time it broadcasts; without a rate
// limit, any client could chain valid authorizations and drain the
// bankroll at the cost of one well-formed signature per second. Two
// dimensions are limited:
//
//   1. Per source IP, read from `X-Forwarded-For` / `X-Real-IP` ONLY
//      when the request arrived on a socket whose remote address is in
//      the configured trusted-proxy set; otherwise the raw socket
//      address is used. Without this gate an attacker can rotate the
//      header per request, defeating the per-IP bucket (see GH issue #7).
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
 * Normalize IPv4-mapped IPv6 addresses (`::ffff:1.2.3.4`) to plain IPv4.
 * Node's HTTP socket frequently exposes loopback as `::ffff:127.0.0.1`
 * even when the proxy is configured as `127.0.0.1`; without normalization
 * the trusted-proxy set check would miss and the forwarded headers would
 * be silently ignored (rate limit too aggressive — safe, but surprising
 * for operators).
 */
function normalizeIp(ip: string): string {
  if (ip.startsWith("::ffff:")) return ip.slice("::ffff:".length);
  return ip;
}

/**
 * Best-effort client-IP extraction.
 *
 * The originating socket address is the only thing we can trust — it is
 * established by the OS kernel from the TCP handshake and cannot be
 * forged by the client. Forwarded headers (`X-Forwarded-For`, `X-Real-IP`)
 * are read ONLY when that socket address belongs to a configured trusted
 * proxy. Without this gate any client can set `X-Forwarded-For: <random>`
 * per request, defeating the per-IP bucket and turning the gas bankroll
 * into a piñata.
 *
 * Order when the socket IS a trusted proxy:
 *   1. First entry in `X-Forwarded-For`.
 *   2. `X-Real-IP`.
 *   3. The raw remote socket address (the proxy itself).
 *
 * Order when the socket is NOT a trusted proxy (or no trust list is set):
 *   1. The raw remote socket address.
 *   2. Literal `"unknown"` — every unidentifiable caller collapses into a
 *      single bucket, which is the safer failure mode (rate limit too
 *      aggressive for misconfigured deploys, never too lax).
 *
 * Operators put the facilitator behind a reverse proxy (Caddy, nginx) on
 * loopback. Configure `FACILITATOR_TRUSTED_PROXIES=127.0.0.1,::1` to
 * surface the real client IP in those deployments.
 */
export function clientIp(
  c: Context,
  trustedProxies?: ReadonlySet<string>,
): string {
  // The Node adapter exposes the original IncomingMessage on c.env.incoming.
  // The exact shape varies across adapters; defensively narrow it.
  const env = c.env as
    | { incoming?: { socket?: { remoteAddress?: string } } }
    | undefined;
  const rawRemote = env?.incoming?.socket?.remoteAddress;
  const remote =
    rawRemote && rawRemote.length > 0 ? normalizeIp(rawRemote) : "unknown";

  // Forwarded headers are honored only when the immediate peer is a known
  // proxy. If no trust list is configured we never trust the headers.
  if (trustedProxies && trustedProxies.size > 0 && trustedProxies.has(remote)) {
    const xff = c.req.header("x-forwarded-for");
    if (xff) {
      const first = xff.split(",")[0];
      if (first && first.trim().length > 0) {
        return normalizeIp(first.trim());
      }
    }
    const realIp = c.req.header("x-real-ip");
    if (realIp && realIp.trim().length > 0) {
      return normalizeIp(realIp.trim());
    }
  }
  return remote;
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
