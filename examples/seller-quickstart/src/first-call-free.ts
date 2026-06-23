// Swarmwage seller — first-call-free gate (SPEC §11).
// License: MIT
//
// Wraps an x402 paymentMiddleware so that the buyer's first hire against
// this seller bypasses payment, per the listing's `first_call_free: true`
// flag. The seller waives the price; everything else in the flow is
// identical (receipt is still signed and submitted, with
// `amount_usdc_atomic = "0"`).
//
// Tracking is in-memory at v0.3: restarting the seller resets eligibility.
// Acceptable for the bootstrap network where we operate the 5 seed sellers
// and a restart is rare. Production sellers SHOULD swap `inMemoryTracker`
// for a persistent store (Postgres / Redis).

import type { Context, MiddlewareHandler, Next } from "hono";

export interface FirstCallFreeTracker {
  /** Read-only — does the tracker already know this buyer? */
  has(buyerId: string): boolean;
  /**
   * Mark buyer as seen. Idempotent. Call from the handler AFTER successful
   * generation so a failed upstream (e.g. backend 5xx) does not silently
   * consume the buyer's one free call.
   */
  markSeen(buyerId: string): void;
  /** Test helper. */
  reset(): void;
}

export function inMemoryTracker(): FirstCallFreeTracker {
  const seen = new Set<string>();
  return {
    has: (b) => seen.has(b.toLowerCase()),
    markSeen: (b) => {
      seen.add(b.toLowerCase());
    },
    reset: () => seen.clear(),
  };
}

/**
 * Build a Hono middleware that gates `paymentMiddleware`: when the request
 * body's `buyer_id` matches a buyer never seen by `tracker`, the payment
 * middleware is bypassed and control flows directly to the handler. On
 * bypass, `c.set("freeCall", true)` so the downstream handler can mark
 * the receipt accordingly.
 *
 * The body is parsed once here; Hono caches `c.req.json()` so the handler
 * can call it again without re-reading the (now consumed) stream.
 */
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
      // Malformed body — defer to payment middleware so the handler can
      // reject with 400 in its own validation. Do NOT bypass payment.
    }

    if (buyerId && !opts.tracker.has(buyerId)) {
      c.set("freeCall", true);
      c.set("freeCallBuyerId", buyerId);
      return next();
    }
    return opts.paymentMiddleware(c, next);
  };
}
