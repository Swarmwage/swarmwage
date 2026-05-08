// Swarmwage Facilitator — POST /settle
// License: BUSL-1.1

import type { Context } from "hono";

import type { Relay } from "../relay.js";
import type { FacilitatorLogStore } from "../store.js";
import type { SettleResponse } from "../types.js";
import { FacilitatorRequestBodySchema } from "../types.js";

interface Deps {
  relay: Relay;
  store: FacilitatorLogStore;
}

export function createSettleHandler({ relay, store }: Deps) {
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

    void store.appendLog({
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

    return c.json(response, 200);
  };
}
