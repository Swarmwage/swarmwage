// Signature verification for protocol messages
// License: BUSL-1.1

import { verifyMessage, keccak256, toBytes } from "viem";
import { canonicalize } from "@swarmwage/agent-sdk";
import type { AgentId, Hex } from "@swarmwage/agent-sdk";

/**
 * Verify a typed payload signature.
 *
 * Mirrors the SDK's `wallet.signTypedPayload`: canonicalized stable JSON →
 * keccak256 hash → eth_personalSign over the raw hash.
 */
export async function verifyTypedPayload(
  agentId: AgentId,
  payload: object,
  signature: Hex,
): Promise<boolean> {
  const canonical = canonicalize(payload);
  const hash = keccak256(toBytes(canonical));
  try {
    return await verifyMessage({
      address: agentId,
      message: { raw: hash },
      signature,
    });
  } catch {
    return false;
  }
}

/**
 * Verify a plain string message signature.
 */
export async function verifyTextMessage(
  agentId: AgentId,
  message: string,
  signature: Hex,
): Promise<boolean> {
  try {
    return await verifyMessage({ address: agentId, message, signature });
  } catch {
    return false;
  }
}
