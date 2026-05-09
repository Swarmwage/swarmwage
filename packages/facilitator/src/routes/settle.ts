// Swarmwage Facilitator — POST /settle
// License: BUSL-1.1

import type { Context } from "hono";

import type { GasGuard } from "../gas-guard.js";
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
  /**
   * Bankroll kill-switch. Two checks: (a) the trailing-hour gas spend
   * must be below the configured cap; (b) the gas wallet balance must
   * be above the configured reserve floor. Both run before the
   * gas-spending broadcast and short-circuit with 503 on breach. The
   * guard's `record()` is invoked after the broadcast — both on success
   * and on on-chain revert — so the cap reflects true bankroll burn.
   */
  gasGuard: GasGuard;
}

export function createSettleHandler({
  relay,
  store,
  addressLimiter,
  gasGuard,
}: Deps) {
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

    // Bankroll kill-switch — hourly spend cap. Sync, no RPC. Short-circuit
    // here so an exhausted bankroll does not pay for an on-chain balance
    // read it cannot act on. Reported as 503 (service-level breach) rather
    // than 429 (per-caller throttle) because the cap is global to this
    // process and not addressable by the caller backing off.
    const hourly = gasGuard.hourlyAllowance();
    if (!hourly.allowed) {
      // Structured stderr line — operators tail/grep `gas_guard.tripped` to
      // catch the breach in real time, not by noticing the 503s in the
      // route log hours later. Format is whitespace-separated key=value
      // for trivial parsing by journalctl / awk / log shippers.
      process.stderr.write(
        `facilitator.gas_guard.tripped reason=hourly_cap spent_wei=${hourly.spentWei} cap_wei=${hourly.capWei} retry_after_sec=${hourly.retryAfterSec}\n`,
      );
      c.header("Retry-After", String(hourly.retryAfterSec));
      return c.json(
        {
          error: "Facilitator gas budget exhausted; service paused",
          retry_after_seconds: hourly.retryAfterSec,
        },
        503,
      );
    }

    // Bankroll kill-switch — reserve floor. Reads the gas wallet balance
    // and refuses if it has fallen below the configured minimum. Catches
    // the "many distinct buyer addresses, each within rate limit" drain
    // pattern that the hourly cap would absorb but ultimately allow.
    let gasBalanceWei: bigint;
    try {
      gasBalanceWei = await relay.gasBalance();
    } catch (err) {
      // RPC unreachable. Fail closed: better to refuse than to broadcast
      // blind. Suggest a short retry; the operator's monitoring layer
      // surfaces the underlying RPC failure.
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `facilitator.gas_guard.tripped reason=balance_rpc_error err=${JSON.stringify(msg)}\n`,
      );
      c.header("Retry-After", "30");
      return c.json(
        {
          error: "Facilitator gas balance check failed; service paused",
          retry_after_seconds: 30,
        },
        503,
      );
    }
    const reserve = gasGuard.reserveCheck(gasBalanceWei);
    if (!reserve.allowed) {
      process.stderr.write(
        `facilitator.gas_guard.tripped reason=reserve_floor balance_wei=${reserve.balanceWei} reserve_wei=${reserve.minReserveWei}\n`,
      );
      // No retry-after suggestion — the operator must top-up the wallet,
      // and there is no machine-readable signal for "when". Buyers should
      // exponentially back off.
      return c.json(
        {
          error: "Facilitator gas reserve below floor; service paused",
        },
        503,
      );
    }

    const { response, gasSpentWei } = await relay.settleAuthorization(
      paymentPayload,
      paymentRequirements,
    );

    // Record gas burn — both on success and on on-chain revert. Skipped
    // when the relay reports null (e.g. the broadcast failed before
    // reaching the network, in which case no ETH was spent). The guard's
    // record() is sync and idempotent w.r.t. zero/negative values.
    if (gasSpentWei !== null) {
      gasGuard.record(gasSpentWei);
    }

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
