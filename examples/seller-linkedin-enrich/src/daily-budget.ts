// © 2026 Swarmwage. MIT.
// Per-agent daily budget guard for the seller's /hire endpoint.
//
// Two caps in one middleware, either of which trips a 503:
//
//   1. MAX_DAILY_HIRES — call-count ceiling. Bounds upstream rate-limit /
//      IP-ban exposure even when the upstream API is "free" (Pollinations,
//      Groq free tier). Without this, an attacker rotating IPs through the
//      per-IP rate limit can still saturate our shared upstream quota.
//
//   2. MAX_DAILY_SPEND_USD — cumulative upstream cost ceiling. Each call is
//      charged EST_UPSTREAM_USD_PER_CALL (configured per-seller); when the
//      sum crosses the cap, /hire is closed for the rest of the UTC day.
//      Bounds the operator's bolletta on paid upstream APIs (Anthropic,
//      fal.ai, Apify) regardless of how the attacker structures the flood.
//
// Reset is at UTC midnight (lazy: the next call after midnight rolls the
// counters). State is in-memory and per-process; multi-replica deployments
// see effective limits = `cap × replicas` until this is moved to Redis.

import type { Context, MiddlewareHandler } from "hono";

export interface DailyBudgetOptions {
  /** Hard cap on successful /hire calls per UTC day. */
  maxHires: number;
  /** Hard cap on cumulative upstream USD per UTC day. */
  maxSpendUsd: number;
}

export class DailyBudget {
  private readonly maxHires: number;
  private readonly maxSpendUsd: number;
  private dateKey: string;
  private hireCount = 0;
  private upstreamSpendUsd = 0;

  constructor(opts: DailyBudgetOptions) {
    if (opts.maxHires < 1 || !Number.isFinite(opts.maxHires)) {
      throw new Error("DailyBudget: maxHires must be a positive integer");
    }
    if (opts.maxSpendUsd < 0 || !Number.isFinite(opts.maxSpendUsd)) {
      throw new Error("DailyBudget: maxSpendUsd must be a non-negative number");
    }
    this.maxHires = Math.floor(opts.maxHires);
    this.maxSpendUsd = opts.maxSpendUsd;
    this.dateKey = todayUtc();
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
    if (this.hireCount >= this.maxHires) {
      return {
        exhausted: true,
        reason: `daily hire cap reached (${this.maxHires})`,
        retryAfterSec: secondsUntilUtcMidnight(),
      };
    }
    if (this.upstreamSpendUsd >= this.maxSpendUsd) {
      return {
        exhausted: true,
        reason: `daily upstream spend cap reached ($${this.maxSpendUsd.toFixed(2)})`,
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

  status(): {
    date: string;
    hires: number;
    spend_usd: number;
    max_hires: number;
    max_spend_usd: number;
  } {
    this.rollover();
    return {
      date: this.dateKey,
      hires: this.hireCount,
      spend_usd: Math.round(this.upstreamSpendUsd * 10000) / 10000,
      max_hires: this.maxHires,
      max_spend_usd: this.maxSpendUsd,
    };
  }
}

function todayUtc(): string {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function secondsUntilUtcMidnight(): number {
  const now = new Date();
  const tomorrow = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
    0,
    0,
    0,
    0,
  );
  return Math.max(1, Math.floor((tomorrow - now.getTime()) / 1000));
}

/**
 * Hono middleware enforcing a DailyBudget. Mount BEFORE paymentMiddleware
 * so an exhausted budget returns 503 without ever taking the buyer's USDC.
 *
 * `estCostUsdPerCall` is the operator-configured per-call upstream cost
 * estimate; it is added to the cumulative spend only on a successful 2xx
 * response from the downstream handler. Failed hires (4xx/5xx) do NOT
 * bump either counter — they neither cost upstream tokens (in most cases)
 * nor are they paid by the buyer.
 */
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
