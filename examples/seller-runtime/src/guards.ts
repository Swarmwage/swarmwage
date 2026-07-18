// Swarmwage example seller runtime — shared resource guards
// License: MIT

import type { Context, MiddlewareHandler, Next } from "hono";

export class DailyBudget {
  private dateKey = todayUtc();
  private hireCount = 0;
  private upstreamSpendUsd = 0;

  constructor(
    private readonly opts: { maxHires: number; maxSpendUsd: number },
  ) {
    if (opts.maxHires < 1 || !Number.isFinite(opts.maxHires)) {
      throw new Error("DailyBudget: maxHires must be a positive integer");
    }
    if (opts.maxSpendUsd < 0 || !Number.isFinite(opts.maxSpendUsd)) {
      throw new Error("DailyBudget: maxSpendUsd must be a non-negative number");
    }
    opts.maxHires = Math.floor(opts.maxHires);
  }

  private rollover(): void {
    const today = todayUtc();
    if (today !== this.dateKey) {
      this.dateKey = today;
      this.hireCount = 0;
      this.upstreamSpendUsd = 0;
    }
  }

  check(): { exhausted: boolean; reason: string; retryAfterSec: number } {
    this.rollover();
    if (this.hireCount >= this.opts.maxHires) {
      return {
        exhausted: true,
        reason: `daily hire cap reached (${this.opts.maxHires})`,
        retryAfterSec: secondsUntilUtcMidnight(),
      };
    }
    if (this.upstreamSpendUsd >= this.opts.maxSpendUsd) {
      return {
        exhausted: true,
        reason: `daily upstream spend cap reached ($${this.opts.maxSpendUsd.toFixed(2)})`,
        retryAfterSec: secondsUntilUtcMidnight(),
      };
    }
    return { exhausted: false, reason: "", retryAfterSec: 0 };
  }

  recordHire(estCostUsd: number): void {
    this.rollover();
    this.hireCount += 1;
    if (estCostUsd > 0) this.upstreamSpendUsd += estCostUsd;
  }

  status() {
    this.rollover();
    return {
      date: this.dateKey,
      hires: this.hireCount,
      spend_usd: Math.round(this.upstreamSpendUsd * 10000) / 10000,
      max_hires: this.opts.maxHires,
      max_spend_usd: this.opts.maxSpendUsd,
    };
  }
}

function todayUtc(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

function secondsUntilUtcMidnight(): number {
  const now = new Date();
  const tomorrow = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
  );
  return Math.max(1, Math.floor((tomorrow - now.getTime()) / 1000));
}

export function dailyBudgetGuard(
  budget: DailyBudget,
  estCostUsdPerCall: number,
): MiddlewareHandler {
  return async (c, next) => {
    const verdict = budget.check();
    if (verdict.exhausted) {
      c.header("Retry-After", String(verdict.retryAfterSec));
      return c.json(
        {
          error: "Daily budget exceeded",
          reason: verdict.reason,
          retry_after_seconds: verdict.retryAfterSec,
        },
        503,
      );
    }
    await next();
    if (c.res.status >= 200 && c.res.status < 300) {
      budget.recordHire(estCostUsdPerCall);
    }
  };
}

export class SlidingWindowLimiter {
  private readonly windows = new Map<string, number[]>();
  private readonly limit: number;
  private readonly windowMs: number;

  constructor(opts: { limit: number; windowMs: number }) {
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
    const trimmed = (this.windows.get(key) ?? []).filter(
      (timestamp) => timestamp > now - this.windowMs,
    );
    if (trimmed.length >= this.limit) {
      this.windows.set(key, trimmed);
      return {
        allowed: false,
        retryAfterMs: Math.max(1, trimmed[0]! + this.windowMs - now),
      };
    }
    trimmed.push(now);
    this.windows.set(key, trimmed);
    return { allowed: true, retryAfterMs: 0 };
  }

  gc(): void {
    const cutoff = Date.now() - this.windowMs;
    for (const [key, timestamps] of this.windows) {
      const current = timestamps.filter((timestamp) => timestamp > cutoff);
      if (current.length === 0) this.windows.delete(key);
      else if (current.length !== timestamps.length) this.windows.set(key, current);
    }
  }
}

export function clientIp(c: Context): string {
  const xff = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
  if (xff) return xff;
  const realIp = c.req.header("x-real-ip")?.trim();
  if (realIp) return realIp;
  const env = c.env as
    | { incoming?: { socket?: { remoteAddress?: string } } }
    | undefined;
  return env?.incoming?.socket?.remoteAddress || "unknown";
}

export function rateLimit(
  limiter: SlidingWindowLimiter,
  getKey: (c: Context) => string,
): MiddlewareHandler {
  return async (c, next) => {
    const result = limiter.check(getKey(c));
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

export interface FirstCallFreeTracker {
  has(buyerId: string): boolean;
  markSeen(buyerId: string): void;
  reset(): void;
}

export function inMemoryTracker(): FirstCallFreeTracker {
  const seen = new Set<string>();
  return {
    has: (buyerId) => seen.has(buyerId.toLowerCase()),
    markSeen: (buyerId) => void seen.add(buyerId.toLowerCase()),
    reset: () => seen.clear(),
  };
}

export function firstCallFreeGate(opts: {
  paymentMiddleware: MiddlewareHandler;
  tracker: FirstCallFreeTracker;
}): MiddlewareHandler {
  return async (c: Context, next: Next) => {
    let buyerId: string | undefined;
    try {
      const body = (await c.req.json()) as { buyer_id?: string };
      buyerId =
        typeof body.buyer_id === "string" ? body.buyer_id.toLowerCase() : undefined;
    } catch {
      // Malformed JSON must not bypass payment.
    }
    if (buyerId && !opts.tracker.has(buyerId)) {
      c.set("freeCall", true);
      c.set("freeCallBuyerId", buyerId);
      return next();
    }
    return opts.paymentMiddleware(c, next);
  };
}
