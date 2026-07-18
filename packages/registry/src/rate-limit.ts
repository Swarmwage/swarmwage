// Swarmwage Registry — in-process token-bucket rate limiter
// License: BUSL-1.1
//
// Defense-in-depth against floods on unauthenticated endpoints
// (/telemetry, /v1/rate, /v1/claim). Token-bucket per client IP. Single
// process — does not coordinate across replicas. For Day-7 single-host
// posture this is sufficient; once we scale horizontally, swap to
// Cloudflare Turnstile / upstream WAF / a Redis bucket.

import type { Context, MiddlewareHandler } from "hono";

interface Bucket {
  tokens: number;
  updatedAt: number;
}

interface RateLimitOptions {
  /** Tokens added per second per client. */
  refillPerSec: number;
  /** Max tokens a client can hold. Equals burst size. */
  burst: number;
  /** Identifier function — defaults to a trusted-proxy-aware client IP. */
  keyOf?: (c: Context) => string;
  /**
   * IPs whose `X-Forwarded-For` / `X-Real-IP` headers the default key is
   * allowed to trust. Empty/undefined ⇒ key exclusively on the raw socket
   * address. Ignored when `keyOf` is supplied.
   */
  trustedProxies?: ReadonlySet<string>;
}

/** Normalize IPv4-mapped IPv6 (`::ffff:1.2.3.4`) to plain IPv4. */
function normalizeIp(ip: string): string {
  if (ip.startsWith("::ffff:")) return ip.slice("::ffff:".length);
  return ip;
}

/**
 * Best-effort client-IP extraction. The originating socket address is the
 * only thing we can trust — it is established by the OS kernel from the TCP
 * handshake and cannot be forged. Forwarded headers (`X-Forwarded-For`,
 * `X-Real-IP`) are read ONLY when the socket peer is a configured trusted
 * proxy. Without this gate any client can rotate `X-Forwarded-For` per
 * request, defeating the per-IP bucket and turning the unauthenticated
 * flood guard into a no-op (same class as facilitator GH#7).
 *
 * Operators behind Caddy/nginx on loopback set
 * `REGISTRY_TRUSTED_PROXIES=127.0.0.1,::1`.
 */
export function clientIp(
  c: Context,
  trustedProxies?: ReadonlySet<string>,
): string {
  const env = c.env as
    | { incoming?: { socket?: { remoteAddress?: string } } }
    | undefined;
  const rawRemote = env?.incoming?.socket?.remoteAddress;
  const remote =
    rawRemote && rawRemote.length > 0 ? normalizeIp(rawRemote) : "unknown";

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

export function rateLimit(opts: RateLimitOptions): MiddlewareHandler {
  const buckets = new Map<string, Bucket>();
  const keyOf = opts.keyOf ?? ((c: Context) => clientIp(c, opts.trustedProxies));

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
