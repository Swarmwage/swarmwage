// Swarmwage Facilitator — POST /settle
// License: BUSL-1.1

import type { Context } from "hono";

import type { SlidingWindowLimiter } from "../rate-limit.js";
import type { Relay } from "../relay.js";
import type { FacilitatorLogStore } from "../store.js";
import type { SettleResponse } from "../types.js";
import { FacilitatorRequestBodySchema } from "../types.js";

interface Deps {
  relay: Relay;
  store: FacilitatorLogStore;
  /**
   * Per-buyer-address rate limiter. Enforced after the payload is parsed
   * (we cannot know the buyer EVM address before decoding the body) and
   * before relay.settleAuthorization, which is the gas-spending call.
   * One buyer rotating IPs still hits a single bucket here.
   */
  addressLimiter: SlidingWindowLimiter;
}

export function createSettleHandler({ relay, store, addressLimiter }: Deps) {
  return async function settle(c: Context): Promise<Response> {
    const start = Date.now();
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const parsed = FacilitatorRequestBodySchema.safeParse(raw);
    if (!parsed.success) {
      return c.json(
        {
          error: "Invalid facilitator request",
          issues: parsed.error.issues,
        },
        400,
      );
    }

    const { paymentPayload, paymentRequirements } = parsed.data;

    // Per-buyer-address rate limit. Defends against a single buyer rotating
    // IPs to bypass the per-IP limiter — they still hit one bucket keyed
    // by `auth.from`. Checked before relay.settleAuthorization because that
    // is the gas-spending broadcast.
    const inner = paymentPayload.payload as
      | { authorization?: { from?: string } }
      | undefined;
    const buyerAddress = inner?.authorization?.from?.toLowerCase();
    if (buyerAddress) {
      const decision = addressLimiter.check(buyerAddress);
      if (!decision.allowed) {
        const retryAfterSec = Math.max(
          1,
          Math.ceil(decision.retryAfterMs / 1000),
        );
        c.header("Retry-After", String(retryAfterSec));
        return c.json(
          {
            error: "Too many requests for this address",
            retry_after_seconds: retryAfterSec,
          },
          429,
        );
      }
    }

    const { response, gasSpentWei } = await relay.settleAuthorization(
      paymentPayload,
      paymentRequirements,
    );

    const latency = Date.now() - start;
    const evmAuth =
      "authorization" in (paymentPayload.payload as Record<string, unknown>)
        ? ((paymentPayload.payload as { authorization: { from: string; to: string; value: string } })
            .authorization)
        : null;

    // Block the response on the log write. The fire-and-forget pattern
    // would silently drop entries on any Postgres error or coercion bug
    // — exactly the failure mode that corrupts the 4-layer data capture
    // story. Surfacing failures to stderr (via store.onError) AND logging
    // a stderr line on .catch() ensures no silent loss; a slow DB shows
    // up as request latency, not as a missing row.
    try {
      await store.appendLog({
        ts: start,
        route: "settle",
        network: paymentPayload.network,
        agent_id: null,
        capability: null,
        payer_address: evmAuth?.from ?? "",
        recipient_address: evmAuth?.to ?? paymentRequirements.payTo,
        amount_usdc_atomic:
          evmAuth?.value ?? paymentRequirements.maxAmountRequired,
        tx_hash: response.transaction || null,
        gas_eth_spent_wei: gasSpentWei !== null ? gasSpentWei.toString() : null,
        latency_ms: latency,
        ok: response.success,
        error: response.errorReason ?? null,
        raw_request: raw,
        raw_response: response satisfies SettleResponse,
      });
    } catch (err) {
      // The store's onError already surfaces this once. We log a second
      // line here so an operator grepping the route logs sees that this
      // specific request did not produce a row, not just that some
      // unspecified write failed somewhere.
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `facilitator.settle.log_write_error tx=${response.transaction || "none"} err=${msg}\n`,
      );
    }

    return c.json(response, 200);
  };
}
