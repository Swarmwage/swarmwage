// Swarmwage Agent SDK — endpoint ownership proof
// License: MIT
//
// Wave-2a fix for the squat attack: a malicious seller can publish a
// listing whose `endpoint` URL points at a third party's server (a
// competitor's hire endpoint, an internal admin panel, an SSRF target).
// Wave 1.5 already blocks the obvious SSRF targets at validation time;
// this module closes the structural variant: the registry now demands a
// nonce-signed proof from the endpoint owner that they control the same
// `agent_id` the listing claims. A squatter cannot satisfy the challenge
// because they don't hold the third party's private key.
//
// Wire format (request/response of `GET <endpoint>/.well-known/swarmwage-verify`):
//
//   GET /.well-known/swarmwage-verify?nonce=<opaque>
//   →  200 application/json
//      { "agent_id": "0x…", "nonce": "<echoed>", "signature": "0x…" }
//
// The signature is produced over the canonical payload `{ agent_id, nonce }`
// using the same `signTypedPayload` flow used for listings + receipts
// (stable-key JSON → keccak256 → eth_personalSign). The registry verifies
// it against the listing's `agent_id` via `verifyTypedPayload`.

import type { AgentId, Hex } from "./types.js";

/** Path the registry challenges; sellers serve their proof at this URL. */
export const ENDPOINT_VERIFY_PATH = "/.well-known/swarmwage-verify";

/** Response body schema for the verify endpoint. */
export interface EndpointVerifyResponse {
  agent_id: AgentId;
  nonce: string;
  signature: Hex;
}

/**
 * Build a signed verify response for the well-known endpoint. Callers
 * supply their own `signTypedPayload` (most sellers already have one
 * locally; the SDK's `createWallet` also provides it). The function is
 * framework-agnostic — wrap it in your Hono / Express / Fastify handler.
 *
 * @example
 *   app.get(ENDPOINT_VERIFY_PATH, async (c) => {
 *     const nonce = c.req.query("nonce");
 *     if (!nonce || nonce.length < 8 || nonce.length > 128) {
 *       return c.json({ error: "Invalid or missing nonce" }, 400);
 *     }
 *     return c.json(await signEndpointVerify(agentId, nonce, signTypedPayload));
 *   });
 */
export async function signEndpointVerify(
  agentId: AgentId,
  nonce: string,
  signTypedPayload: (payload: object) => Promise<Hex>,
): Promise<EndpointVerifyResponse> {
  const signature = await signTypedPayload({
    agent_id: agentId,
    nonce,
  });
  return { agent_id: agentId, nonce, signature };
}
