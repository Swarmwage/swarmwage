// Swarmwage Agent SDK — seller-side receipt submission
// Layer 3 of the 4-layer data capture model: sellers sign and submit
// receipts after each fulfilled hire so their public reputation
// reflects on-protocol activity.
// Default ON; opt out via env var SWARMWAGE_RECEIPTS=0.
// License: MIT

import { createWallet, type AgentWallet } from "./wallet.js";
import type {
  AgentId,
  CapabilityId,
  Hex,
  ProtocolVersion,
  VerificationResult,
} from "./types.js";

export const DEFAULT_REGISTRY_URL = "https://api.swarmwage.com";

/**
 * Network the on-chain settlement happened on. Mirrors the SDK's
 * `SwarmwageNetwork` and the registry's accepted enum.
 */
export type ReceiptNetwork = "base" | "base-sepolia";

/**
 * The fields the seller signs. Sent verbatim (alphabetically ordered)
 * to the registry so the server can recover the address.
 */
export interface ReceiptPayload {
  protocol_version: ProtocolVersion | string;
  /** SDK-generated UUID per hire — idempotency key. */
  hire_id: string;
  /** Seller (signer). Lowercase 0x address. */
  agent_id: AgentId;
  /**
   * Settled payment recipient, when distinct from `agent_id` (GH #11).
   * MUST equal the `payee` bound into the seller's signed listing — the same
   * tuple the buyer's anti-hijack check validated. Omit for single-EOA
   * sellers (payments went to `agent_id`).
   */
  payee?: AgentId;
  /** Buyer address (informational). */
  buyer: AgentId;
  capability: CapabilityId;
  capability_version?: string;
  /** USDC atomic units (6 decimals), as a string for BigInt safety. */
  amount_usdc_atomic: string;
  network: ReceiptNetwork;
  tx_hash: `0x${string}`;
  /** ISO 8601 timestamp. */
  completed_at: string;
  verification: VerificationResult | { all_passed: boolean; checks: Record<string, boolean> };
}

export interface SubmitReceiptOptions {
  /** Override the canonical registry URL. Defaults to api.swarmwage.com. */
  registryUrl?: string;
  /** Seller private key, used to sign the payload. */
  sellerPrivateKey: Hex;
  /** Receipt content. Signature is added internally. */
  payload: ReceiptPayload;
  /** Force on/off. Defaults to env var `SWARMWAGE_RECEIPTS` (off=`0|false|off|no`). */
  enabled?: boolean;
  /** Optional logger. Defaults to writing to `process.stderr`. */
  logger?: (msg: string) => void;
  /** Override fetch (for tests). Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
}

export interface SubmitReceiptResult {
  /** True when the SDK submitted (or attempted to submit). False when opted out. */
  submitted: boolean;
  /** HTTP status code if a response was received. */
  status?: number;
  /** Receipt ID returned by the registry on success. */
  receipt_id?: string;
  /** Error message (if any). Errors are NOT thrown by `submitReceipt`. */
  error?: string;
}

/**
 * Decide whether receipt submission is enabled. Mirrors the
 * `AGENT_TELEMETRY` opt-out semantics for symmetry.
 */
export function isReceiptsEnabled(
  enabled: boolean | undefined,
  env: Record<string, string | undefined> = (typeof process !== "undefined"
    ? (process.env as Record<string, string | undefined>)
    : {}),
): boolean {
  if (enabled !== undefined) return enabled;
  const raw = env.SWARMWAGE_RECEIPTS;
  if (raw === undefined) return true;
  const v = raw.trim().toLowerCase();
  if (v === "0" || v === "false" || v === "off" || v === "no") return false;
  return true;
}

/**
 * Sign a receipt payload using the canonical scheme:
 * stable JSON (alphabetical keys) → keccak256 → eth_personalSign.
 *
 * Returns the `{ signature, body }` so callers can submit elsewhere if
 * they want without going through `submitReceipt`.
 */
export async function signReceipt(
  wallet: AgentWallet,
  payload: ReceiptPayload,
): Promise<{ signature: Hex; body: ReceiptPayload & { signature: Hex } }> {
  const signature = await wallet.signTypedPayload(payload);
  return { signature, body: { ...payload, signature } };
}

/**
 * Submit a signed receipt to the registry. Fire-and-forget semantics:
 * never throws, errors are returned in the result and logged via
 * `opts.logger`. Safe to `await` from a seller's `/hire` handler without
 * blocking the buyer's response.
 *
 * Default ON; set env `SWARMWAGE_RECEIPTS=0` to disable.
 */
export async function submitReceipt(
  opts: SubmitReceiptOptions,
): Promise<SubmitReceiptResult> {
  const log =
    opts.logger ??
    ((msg: string) => {
      try {
        if (typeof process !== "undefined" && process.stderr?.write) {
          process.stderr.write(`swarmwage-receipts: ${msg}\n`);
        }
      } catch {
        // swallow — logging is best-effort
      }
    });

  if (!isReceiptsEnabled(opts.enabled)) {
    return { submitted: false };
  }

  const url = `${(opts.registryUrl ?? DEFAULT_REGISTRY_URL).replace(/\/$/, "")}/v1/receipts`;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;

  let signedBody: ReceiptPayload & { signature: Hex };
  try {
    const wallet = createWallet({ privateKey: opts.sellerPrivateKey });
    // Sanity: the payload must declare itself as the wallet we're signing with.
    if (
      opts.payload.agent_id.toLowerCase() !== wallet.agentId.toLowerCase()
    ) {
      const err = `payload.agent_id ${opts.payload.agent_id} does not match seller wallet ${wallet.agentId}`;
      log(err);
      return { submitted: true, error: err };
    }
    const { body } = await signReceipt(wallet, opts.payload);
    signedBody = body;
  } catch (err) {
    const msg = `sign failed: ${(err as Error).message}`;
    log(msg);
    return { submitted: true, error: msg };
  }

  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(signedBody),
      keepalive: true,
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      log(`registry rejected receipt (${res.status}): ${txt}`);
      return { submitted: true, status: res.status, error: txt || res.statusText };
    }
    const json = (await res.json().catch(() => ({}))) as {
      receipt_id?: string;
      ok?: boolean;
    };
    return {
      submitted: true,
      status: res.status,
      receipt_id: json.receipt_id,
    };
  } catch (err) {
    const msg = `network error: ${(err as Error).message}`;
    log(msg);
    return { submitted: true, error: msg };
  }
}
