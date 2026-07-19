// Swarmwage Agent SDK — x402 v2 payment layer
// License: MIT
//
// Wraps @x402/fetch + @x402/core + @x402/evm (x402 protocol v2) behind a small
// surface the AgentClient uses to build payment-enabled fetch functions. A
// single client is dual-registered for v2 (CAIP-2 network ids, e.g. external
// agentic.market endpoints) and v1 (bare network name, e.g. our own sellers),
// so one code path pays both.

import { wrapFetchWithPayment } from "@x402/fetch";
import { x402Client, type SelectPaymentRequirements } from "@x402/core/client";
import type { Network, PaymentRequirements } from "@x402/core/types";
import { ExactEvmScheme, toClientEvmSigner } from "@x402/evm";
import { ExactEvmSchemeV1 } from "@x402/evm/exact/v1/client";
import { decodePaymentResponseHeader } from "@x402/core/http";
import type { PrivateKeyAccount } from "viem/accounts";
import { SellerMismatchError } from "./errors.js";
import type { AgentId } from "./types.js";
import type { SwarmwageNetwork } from "./client.js";

// CAIP-2 chain ids. x402 v2 identifies networks as "eip155:<chainId>"; v1 (our
// own sellers, pre-migration) used the bare name "base" / "base-sepolia".
const CAIP2: Record<SwarmwageNetwork, string> = {
  base: "eip155:8453",
  "base-sepolia": "eip155:84532",
};

export function networkToCaip2(network: SwarmwageNetwork): string {
  return CAIP2[network];
}

// A PaymentRequirements from the wire is either v2 (`amount`) or v1
// (`maxAmountRequired`). The @x402/core union schema accepts both shapes; this
// reads whichever price field is present as atomic USDC units.
interface WireRequirement {
  network?: string;
  payTo?: string;
  amount?: string;
  maxAmountRequired?: string;
  extra?: Record<string, unknown>;
  [k: string]: unknown;
}

function requirementAtomic(r: WireRequirement): bigint {
  const raw = r.amount ?? r.maxAmountRequired;
  if (raw === undefined) {
    throw new Error("x402 payment requirement has no amount / maxAmountRequired");
  }
  return BigInt(raw);
}

function requirementNetworkMatches(
  r: WireRequirement,
  network: SwarmwageNetwork,
): boolean {
  const n = String(r.network ?? "");
  // Accept the CAIP-2 form (v2) or the bare name (v1 sellers).
  return n === CAIP2[network] || n === network;
}

export interface BuildPaidFetchOptions {
  /** The buyer's viem account; signs the EIP-3009 authorization. */
  account: PrivateKeyAccount;
  /** Network to force selection onto. */
  network: SwarmwageNetwork;
  /**
   * Hard spend cap in atomic USDC units. Selecting a requirement above this
   * THROWS — the SDK never silently downgrades or pays beyond the cap.
   */
  maxValueAtomic: bigint;
  /**
   * When set, the chosen requirement's `payTo` MUST equal this address
   * (anti-hijack). This is the listing's signed `payee` when present, else the
   * seller's `agent_id` — the SAME signed tuple that receipts bind, never a
   * separate normalization of it. Mismatch THROWS `SellerMismatchError`
   * before any signature.
   */
  expectedPayTo?: AgentId;
  /** Advertised to facilitator-aware sellers via `requirement.extra`. */
  facilitatorUrl: string | null;
  /**
   * Called with the atomic amount of the selected requirement, for budget
   * estimation. Fires only when a 402 challenge is actually selected.
   */
  onSelected?: (atomic: bigint) => void;
  /**
   * Called with the structured error when the selector rejects a requirement
   * (network mismatch, spend cap, or seller mismatch), BEFORE @x402/fetch
   * wraps it into a generic "Failed to create payment payload" error. Lets the
   * caller restore the typed error (e.g. SellerMismatchError) it expects.
   */
  onReject?: (err: Error) => void;
}

/**
 * Build a payment-enabled fetch backed by x402 v2, dual-registered for v2
 * (CAIP-2) and v1 (bare network name).
 *
 * The selector enforces, BEFORE any signature is created:
 *  1. network-force — only requirements on the configured network are eligible
 *     (an attacker can't splice a cross-chain requirement to drain a wallet
 *     that holds funds elsewhere);
 *  2. anti-hijack — when `expectedPayTo` is set (signed listing payee, falling
 *     back to agent_id), `payTo` must match or it THROWS `SellerMismatchError`;
 *  3. spend cap — selecting a requirement above `maxValueAtomic` THROWS;
 *  4. facilitator hint — annotates `extra.swarmwageFacilitatorUrl` (the same
 *     hint the transport also sends as the `X-Swarmwage-Facilitator` header).
 */
export function buildPaidFetch(opts: BuildPaidFetchOptions): typeof fetch {
  const signer = toClientEvmSigner(opts.account);
  // v2 (CAIP-2 network) and v1 (bare "base") use DIFFERENT scheme clients: the
  // v2 ExactEvmScheme only signs CAIP-2 networks and throws on "base", which is
  // exactly the shape our own x402-hono sellers emit. Register each on its path.
  const scheme = new ExactEvmScheme(signer);
  const schemeV1 = new ExactEvmSchemeV1(signer);

  const selector: SelectPaymentRequirements = (_x402Version, reqs) => {
    // @x402/core hands us the parsed v1|v2 union; view each as WireRequirement
    // to read the price/payTo fields uniformly across protocol versions.
    const wire = reqs as unknown as WireRequirement[];
    // @x402/fetch swallows whatever the selector throws and re-wraps it as a
    // generic payment-creation error; reject() reports the structured error
    // first so the caller can restore the typed error it expects.
    const reject = (err: Error): never => {
      opts.onReject?.(err);
      throw err;
    };

    const eligible = wire.filter((r) =>
      requirementNetworkMatches(r, opts.network),
    );
    const chosen = eligible[0];
    if (!chosen) {
      return reject(
        new Error(
          `No x402 payment requirement on the configured network (${opts.network})`,
        ),
      );
    }

    // Anti-hijack: reject before signing if payTo isn't the signed recipient.
    if (opts.expectedPayTo) {
      const expected = opts.expectedPayTo.toLowerCase();
      const actual = String(chosen.payTo ?? "").toLowerCase();
      if (actual !== expected) {
        return reject(new SellerMismatchError(expected, actual || "(missing)"));
      }
    }

    // Spend cap: hard-fail above the caller's cap — never silently downgrade.
    const atomic = requirementAtomic(chosen);
    if (atomic > opts.maxValueAtomic) {
      return reject(
        new Error(
          `x402 payment amount ${atomic} exceeds cap ${opts.maxValueAtomic}`,
        ),
      );
    }

    opts.onSelected?.(atomic);

    if (opts.facilitatorUrl) {
      // `extra` is an opaque Record in the x402 spec; annotating it does not
      // invalidate the EIP-3009 authorization (which covers only from/to/value/
      // validAfter/validBefore/nonce).
      const annotated: WireRequirement = {
        ...chosen,
        extra: {
          ...(chosen.extra ?? {}),
          swarmwageFacilitatorUrl: opts.facilitatorUrl,
        },
      };
      return annotated as unknown as PaymentRequirements;
    }
    return chosen as unknown as PaymentRequirements;
  };

  // x402Client's constructor takes the selector directly; schemes are attached
  // via the chainable register()/registerV1() (v2 CAIP-2 + v1 bare name).
  const client = new x402Client(selector)
    .register(networkToCaip2(opts.network) as Network, scheme)
    .registerV1(opts.network, schemeV1);

  return wrapFetchWithPayment(globalThis.fetch, client) as unknown as typeof fetch;
}

export interface SettlementInfo {
  txHash?: string;
  /** Actual settled amount in atomic USDC units, when the scheme reports it. */
  amountAtomic?: bigint;
}

// x402 v2 sellers set the settlement on `Payment-Response`; v1 / x402-hono
// sellers use the `X-Payment-Response` spelling. Try both.
const SETTLEMENT_HEADERS = ["Payment-Response", "X-Payment-Response"];

/**
 * Decode the seller's settlement response header (set after on-chain settle)
 * into the tx hash and actual settled amount. Returns empty fields when the
 * header is absent or unparseable.
 */
export function decodeSettlement(res: Response): SettlementInfo {
  let raw: string | null = null;
  for (const name of SETTLEMENT_HEADERS) {
    raw = res.headers.get(name);
    if (raw) break;
  }
  if (!raw) return {};
  try {
    const settle = decodePaymentResponseHeader(raw) as {
      transaction?: string;
      amount?: string;
    };
    return {
      txHash: settle.transaction || undefined,
      amountAtomic: settle.amount ? BigInt(settle.amount) : undefined,
    };
  } catch {
    return {};
  }
}
