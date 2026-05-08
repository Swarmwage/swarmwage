// Swarmwage Facilitator — POST /verify
// License: BUSL-1.1

import type { Context } from "hono";

import type { Relay } from "../relay.js";
import type { FacilitatorLogStore } from "../store.js";
import type { VerifyResponse } from "../types.js";
import { FacilitatorRequestBodySchema } from "../types.js";

interface Deps {
  relay: Relay;
  store: FacilitatorLogStore;
}

export function createVerifyHandler({ relay, store }: Deps) {
  return async function verify(c: Context): Promise<Response> {
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

    const result: VerifyResponse = await relay.verifyAuthorization(
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
      route: "verify",
      network: paymentPayload.network,
      agent_id: null,
      capability: null,
      payer_address: evmAuth?.from ?? "",
      recipient_address: evmAuth?.to ?? paymentRequirements.payTo,
      amount_usdc_atomic: evmAuth?.value ?? paymentRequirements.maxAmountRequired,
      tx_hash: null,
      gas_eth_spent_wei: null,
      latency_ms: latency,
      ok: result.isValid,
      error: result.invalidReason ?? null,
      raw_request: raw,
      raw_response: result,
    });

    return c.json(result, 200);
  };
}
