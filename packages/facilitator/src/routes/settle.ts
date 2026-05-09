// Swarmwage Facilitator — POST /settle
// License: BUSL-1.1

import type { Context } from "hono";

import type { GasGuard } from "../gas-guard.js";
import type { SlidingWindowLimiter } from "../rate-limit.js";
import type { Relay } from "../relay.js";
import type { FacilitatorLogStore } from "../store.js";
import type { PaymentPayload, SettleResponse } from "../types.js";
import { FacilitatorRequestBodySchema } from "../types.js";

// Outer ceiling on the entire settleAuthorization call. The inner viem
// waitForTransactionReceipt has its own 30s timeout (relay.ts), so this
// covers the catastrophic case where verification or broadcast itself
// hangs (RPC partition, deadlock in a future relay refactor). A 60s
// total ceiling keeps Hono from holding a connection open indefinitely.
const SETTLE_TOTAL_TIMEOUT_MS = 60_000;

class SettleTimeoutError extends Error {
  constructor() {
    super("settle total timeout");
    this.name = "SettleTimeoutError";
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new SettleTimeoutError()), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

// Test-only handle on the timeout primitives. Not part of the public API;
// imported only from `src/__test__/`. Exposed here so the unit test can
// exercise the timer behaviour against a tight clock instead of waiting
// the production 60s ceiling.
export const __test__ = {
  withTimeout,
  SettleTimeoutError,
};

interface EvmAuthFields {
  from: string;
  to: string;
  value: string;
}

/**
 * Narrow `paymentPayload.payload` to the EVM `transferWithAuthorization`
 * shape and return its three log-relevant fields. Returns null when the
 * payload is not the expected EVM exact-scheme shape — for `scheme=exact`
 * on EVM that should be impossible after Zod validation, so callers must
 * treat null as a divergence signal (logged, not silently absorbed).
 */
function extractEvmAuth(payload: PaymentPayload): EvmAuthFields | null {
  const inner = payload.payload as
    | { authorization?: { from?: unknown; to?: unknown; value?: unknown } }
    | undefined;
  const auth = inner?.authorization;
  if (
    !auth ||
    typeof auth.from !== "string" ||
    typeof auth.to !== "string" ||
    typeof auth.value !== "string"
  ) {
    return null;
  }
  return { from: auth.from, to: auth.to, value: auth.value };
}

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
    //
    // For `scheme=exact` on EVM networks the upstream x402 schema requires
    // `payload.authorization.from` (it is a required `z.string()` inside
    // a required `authorization` ZodObject), so this lookup cannot return
    // null for a Zod-valid request. The `if (buyerAddress)` guard is
    // defensive: it covers the SVM exact-payload shape (no `authorization`
    // field) that is impossible on the Base/Base-Sepolia networks this
    // facilitator supports but which the union still types as reachable.
    // For SVM-shaped payloads the relay rejects with `invalid_payload`
    // before any broadcast, so the per-IP limiter alone is sufficient.
    const evmAuthForLimiter = extractEvmAuth(paymentPayload);
    const buyerAddress = evmAuthForLimiter?.from.toLowerCase();
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

    // Settlement: outer try/catch + total-time ceiling. Two failure modes
    // we explicitly defend against here:
    //   (a) a future bug in the relay that lets a throw escape its
    //       internal try/catches — without this wrap it would propagate
    //       to Hono's default error handler, return 500, and never write
    //       a log row;
    //   (b) a catastrophic hang — viem's polling has no built-in ceiling
    //       outside the receipt wait, so a partition during an RPC read
    //       in verifyAuthorization could pin a Hono connection.
    // Either way: we log a structured stderr line, write a best-effort
    // log row marking the failure, and return a controlled response.
    let response: SettleResponse;
    let gasSpentWei: bigint | null = null;
    try {
      const result = await withTimeout(
        relay.settleAuthorization(paymentPayload, paymentRequirements),
        SETTLE_TOTAL_TIMEOUT_MS,
      );
      response = result.response;
      gasSpentWei = result.gasSpentWei;
    } catch (err) {
      const isTimeout = err instanceof SettleTimeoutError;
      const failureReason = isTimeout
        ? "settle_timeout"
        : "settle_unexpected_error";
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `facilitator.${failureReason} latency_ms=${Date.now() - start} err=${JSON.stringify(msg)}\n`,
      );

      // Best-effort audit row. The relay never returned, so we have no
      // tx hash and no gas reading; pull addresses from the parsed
      // request instead. If even the log write fails we drop a second
      // stderr line and let the response carry on — chain state is the
      // source of truth, the row is for our analytics.
      const evmAuth = extractEvmAuth(paymentPayload);
      try {
        await store.appendLog({
          ts: start,
          route: "settle",
          network: paymentPayload.network,
          agent_id: null,
          capability: null,
          payer_address: evmAuth?.from ?? "",
          recipient_address:
            evmAuth?.to ?? paymentRequirements.payTo,
          amount_usdc_atomic:
            evmAuth?.value ?? paymentRequirements.maxAmountRequired,
          tx_hash: null,
          gas_eth_spent_wei: null,
          latency_ms: Date.now() - start,
          ok: false,
          error: failureReason,
          raw_request: raw,
          raw_response: { error: msg, reason: failureReason },
        });
      } catch (logErr) {
        const logMsg =
          logErr instanceof Error ? logErr.message : String(logErr);
        process.stderr.write(
          `facilitator.settle.log_write_error reason=${failureReason} err=${JSON.stringify(logMsg)}\n`,
        );
      }

      if (isTimeout) {
        return c.json(
          {
            error:
              "Facilitator settle timed out; the transaction may still confirm on-chain",
          },
          504,
        );
      }
      return c.json(
        { error: "Facilitator settle encountered an unexpected error" },
        500,
      );
    }

    // Record gas burn — both on success and on on-chain revert. Skipped
    // when the relay reports null (e.g. the broadcast failed before
    // reaching the network, in which case no ETH was spent). The guard's
    // record() is sync and idempotent w.r.t. zero/negative values.
    if (gasSpentWei !== null) {
      gasGuard.record(gasSpentWei);
    }

    const latency = Date.now() - start;
    const evmAuth = extractEvmAuth(paymentPayload);
    if (paymentPayload.scheme === "exact" && !evmAuth) {
      // For scheme=exact the EVM authorization payload MUST be present —
      // upstream Zod validation should already reject the malformed shape.
      // Reaching this point with no auth means the schema admitted an
      // invalid payload OR the relay returned success on a shape we did
      // not expect. Either way it is a developer-level divergence, not a
      // user error; the row will land with empty payer/recipient as a
      // sentinel and this stderr line gives analytics the signal to
      // hunt the upstream parsing bug.
      process.stderr.write(
        `facilitator.settle.evm_auth_missing scheme=exact network=${paymentPayload.network}\n`,
      );
    }

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
