// Swarmwage Facilitator — gas relay (verify + broadcast)
// License: BUSL-1.1
//
// This file contains the on-chain interaction surface of the facilitator.
// Two responsibilities only:
//
//   1. `verifyAuthorization` — given a signed EIP-3009 authorization and the
//      payment requirements that justify it, decide whether broadcasting it
//      would succeed. Pure read: no transaction is sent.
//   2. `settleAuthorization` — broadcast `USDC.transferWithAuthorization()`
//      on behalf of the buyer, paying the ETH gas from the configured
//      facilitator wallet. The USDC moves directly buyer → seller via the
//      USDC contract; the facilitator wallet never holds, custodies, or
//      transfers USDC at any point in the flow.
//
// Anything outside of those two responsibilities does not belong in this
// file.

import {
  createPublicClient,
  createWalletClient,
  http,
  hexToBigInt,
  type Account,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";

// viem produces chain-specific Client types: a Base client knows about deposit
// transactions (OP-Stack) and a Sepolia client doesn't. Exposing the result of
// `createPublicClient({ chain })` as a single static type across both networks
// in the same module is structurally impossible — they differ in the
// `transactions` shape returned by `getBlock`. Runtime behaviour is identical;
// only the static type is generic-explosive. We accept `any` here as the
// pragmatic surface for both client objects.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PublicClientLike = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type WalletClientLike = any;

import type { FacilitatorEnv, FacilitatorNetwork } from "./env.js";
import type {
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  VerifyResponse,
} from "./types.js";
import {
  splitSignature,
  TRANSFER_WITH_AUTHORIZATION_TYPES,
  USDC_ABI,
  USDC_ADDRESS,
  usdcEip712Domain,
} from "./usdc.js";

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

const CHAIN_BY_NETWORK = {
  base,
  "base-sepolia": baseSepolia,
} as const;

export interface Relay {
  readonly network: FacilitatorNetwork;
  readonly chainId: number;
  readonly account: Account;
  readonly publicClient: PublicClientLike;
  readonly walletClient: WalletClientLike;
  /** Wei balance of the gas-paying wallet. */
  gasBalance(): Promise<bigint>;
  verifyAuthorization(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<VerifyResponse>;
  settleAuthorization(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<{ response: SettleResponse; gasSpentWei: bigint | null }>;
}

export function createRelay(env: FacilitatorEnv): Relay {
  const chain = CHAIN_BY_NETWORK[env.network];
  const account = privateKeyToAccount(env.gasPrivateKey);

  const transport = http(env.rpcUrl);
  const publicClient = createPublicClient({ chain, transport });
  const walletClient = createWalletClient({ account, chain, transport });

  const network = env.network;

  // Per-relay set of in-flight `(from, nonce)` pairs currently being
  // broadcast. The check-and-add at settle time is sync (no await between
  // `has` and `add`), so under Node's single-threaded model two concurrent
  // /settle calls for the same authorization cannot both reach
  // writeContract — the second one returns invalid_transaction_state
  // without burning gas on a guaranteed on-chain revert. The slot is
  // released in finally{} after waitForTransactionReceipt resolves.
  const inFlightNonces = new Set<string>();

  return {
    network,
    chainId: chain.id,
    account,
    publicClient,
    walletClient,

    async gasBalance() {
      return publicClient.getBalance({ address: account.address });
    },

    async verifyAuthorization(payload, requirements) {
      return verifyAuthorization({
        payload,
        requirements,
        network,
        chainId: chain.id,
        publicClient,
      });
    },

    async settleAuthorization(payload, requirements) {
      return settleAuthorization({
        payload,
        requirements,
        network,
        chainId: chain.id,
        publicClient,
        walletClient,
        account,
        inFlightNonces,
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildVerifyFailure(
  reason: VerifyResponse["invalidReason"],
  payer?: string,
): VerifyResponse {
  return { isValid: false, invalidReason: reason, payer };
}

function buildSettleFailure(
  network: FacilitatorNetwork,
  reason: SettleResponse["errorReason"],
  payer?: string,
): SettleResponse {
  return {
    success: false,
    network,
    transaction: "",
    payer,
    errorReason: reason,
  };
}

/**
 * Narrow a `PaymentPayload.payload` to the EVM `transferWithAuthorization`
 * shape. Returns `null` if the payload is not the expected EVM exact-scheme
 * shape (e.g. an SVM transaction blob).
 */
function asEvmAuthorization(
  payload: PaymentPayload,
): { signature: Hex; authorization: EvmAuthorization } | null {
  const inner = payload.payload as unknown as
    | { signature?: string; authorization?: EvmAuthorization }
    | { transaction?: string };
  if (!("signature" in inner) || !inner.signature || !inner.authorization) {
    return null;
  }
  return {
    signature: inner.signature as Hex,
    authorization: inner.authorization,
  };
}

interface EvmAuthorization {
  from: string;
  to: string;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: string;
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

interface VerifyArgs {
  payload: PaymentPayload;
  requirements: PaymentRequirements;
  network: FacilitatorNetwork;
  chainId: number;
  publicClient: PublicClientLike;
}

async function verifyAuthorization(args: VerifyArgs): Promise<VerifyResponse> {
  const { payload, requirements, network, chainId, publicClient } = args;

  // Scheme + network must match what we support.
  if (payload.scheme !== "exact" || requirements.scheme !== "exact") {
    return buildVerifyFailure("invalid_scheme");
  }
  if (payload.network !== network || requirements.network !== network) {
    return buildVerifyFailure("invalid_network");
  }

  const evm = asEvmAuthorization(payload);
  if (!evm) {
    return buildVerifyFailure("invalid_payload");
  }
  const auth = evm.authorization;
  const payer = auth.from;

  // Recipient must match the seller declared in `paymentRequirements.payTo`.
  if (auth.to.toLowerCase() !== requirements.payTo.toLowerCase()) {
    return buildVerifyFailure(
      "invalid_exact_evm_payload_recipient_mismatch",
      payer,
    );
  }

  // Asset must match the USDC address for the active network.
  if (
    requirements.asset.toLowerCase() !== USDC_ADDRESS[network].toLowerCase()
  ) {
    return buildVerifyFailure("invalid_payment_requirements", payer);
  }

  // Amount: authorized `value` must be at least `maxAmountRequired`.
  const required = safeBigInt(requirements.maxAmountRequired);
  const authorized = safeBigInt(auth.value);
  if (required === null || authorized === null) {
    return buildVerifyFailure("invalid_exact_evm_payload_authorization_value", payer);
  }
  // Reject zero-amount payments. The upstream x402 schema admits the
  // literal string "0" as a valid integer for both `maxAmountRequired`
  // and `auth.value` (its refine() only checks `Number(v) >= 0`). Without
  // this guard, a buyer could submit a free authorization for 0 USDC
  // that nonetheless burns real ETH gas on broadcast — a zero-cost
  // gas-drain attack with no economic substance for either party.
  if (required <= 0n || authorized <= 0n) {
    return buildVerifyFailure("invalid_payment_requirements", payer);
  }
  if (authorized < required) {
    return buildVerifyFailure(
      "invalid_exact_evm_payload_authorization_value",
      payer,
    );
  }

  // Time bounds.
  const now = BigInt(Math.floor(Date.now() / 1000));
  const validAfter = safeBigInt(auth.validAfter);
  const validBefore = safeBigInt(auth.validBefore);
  if (validAfter === null || validBefore === null) {
    return buildVerifyFailure("invalid_payload", payer);
  }
  if (now < validAfter) {
    return buildVerifyFailure(
      "invalid_exact_evm_payload_authorization_valid_after",
      payer,
    );
  }
  if (now >= validBefore) {
    return buildVerifyFailure("payment_expired", payer);
  }

  // Signature shape + low-S canonical check. Reject high-S now so that
  // /verify and /settle agree: a payload that passes verify must also
  // pass the splitSignature gate at settle time. viem's recoverTypedData
  // normalizes high-S internally and would still recover the correct
  // address, hiding the malleability — so we cannot rely on it for this
  // check.
  try {
    splitSignature(evm.signature);
  } catch {
    return buildVerifyFailure(
      "invalid_exact_evm_payload_signature",
      payer,
    );
  }

  // EIP-712 signature recovery.
  const recovered = await recoverAuthorizationSigner(
    auth,
    evm.signature,
    network,
    chainId,
  );
  if (
    !recovered ||
    recovered.toLowerCase() !== auth.from.toLowerCase()
  ) {
    return buildVerifyFailure(
      "invalid_exact_evm_payload_signature",
      payer,
    );
  }

  // Nonce must not already be consumed on-chain.
  try {
    const used = (await publicClient.readContract({
      address: USDC_ADDRESS[network],
      abi: USDC_ABI,
      functionName: "authorizationState",
      args: [auth.from as Address, auth.nonce as Hex],
    })) as boolean;
    if (used) {
      return buildVerifyFailure("invalid_transaction_state", payer);
    }
  } catch {
    return buildVerifyFailure("unexpected_verify_error", payer);
  }

  // Payer balance must cover the authorized amount.
  try {
    const balance = (await publicClient.readContract({
      address: USDC_ADDRESS[network],
      abi: USDC_ABI,
      functionName: "balanceOf",
      args: [auth.from as Address],
    })) as bigint;
    if (balance < authorized) {
      return buildVerifyFailure("insufficient_funds", payer);
    }
  } catch {
    return buildVerifyFailure("unexpected_verify_error", payer);
  }

  return { isValid: true, payer };
}

function safeBigInt(value: string): bigint | null {
  try {
    if (/^0x[0-9a-fA-F]+$/.test(value)) return hexToBigInt(value as Hex);
    if (/^\d+$/.test(value)) return BigInt(value);
    return null;
  } catch {
    return null;
  }
}

async function recoverAuthorizationSigner(
  auth: EvmAuthorization,
  signature: Hex,
  network: FacilitatorNetwork,
  chainId: number,
): Promise<string | null> {
  const { recoverTypedDataAddress } = await import("viem");
  try {
    return await recoverTypedDataAddress({
      domain: usdcEip712Domain(network, chainId),
      types: TRANSFER_WITH_AUTHORIZATION_TYPES,
      primaryType: "TransferWithAuthorization",
      message: {
        from: auth.from as Address,
        to: auth.to as Address,
        value: BigInt(auth.value),
        validAfter: BigInt(auth.validAfter),
        validBefore: BigInt(auth.validBefore),
        nonce: auth.nonce as Hex,
      },
      signature,
    });
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Settlement
// ---------------------------------------------------------------------------

interface SettleArgs {
  payload: PaymentPayload;
  requirements: PaymentRequirements;
  network: FacilitatorNetwork;
  chainId: number;
  publicClient: PublicClientLike;
  walletClient: WalletClientLike;
  account: Account;
  inFlightNonces: Set<string>;
}

function inFlightKey(from: string, nonce: string): string {
  return `${from.toLowerCase()}:${nonce.toLowerCase()}`;
}

async function settleAuthorization(
  args: SettleArgs,
): Promise<{ response: SettleResponse; gasSpentWei: bigint | null }> {
  const {
    payload,
    requirements,
    network,
    publicClient,
    walletClient,
    account,
    inFlightNonces,
  } = args;

  // Re-run verification before broadcasting. Cheap insurance against a
  // /verify being skipped or stale state being acted on.
  const pre = await verifyAuthorization({
    payload,
    requirements,
    network,
    chainId: args.chainId,
    publicClient,
  });
  if (!pre.isValid) {
    return {
      response: buildSettleFailure(
        network,
        verifyReasonToSettleReason(pre.invalidReason),
        pre.payer,
      ),
      gasSpentWei: null,
    };
  }

  const evm = asEvmAuthorization(payload);
  if (!evm) {
    return {
      response: buildSettleFailure(network, "invalid_payload"),
      gasSpentWei: null,
    };
  }
  const auth = evm.authorization;

  // Claim the in-flight slot for this (from, nonce). The has-then-add
  // sequence is sync — no await between the two calls — so under Node's
  // single-threaded execution model two concurrent settles for the same
  // authorization cannot both pass this gate. The second returns
  // invalid_transaction_state without ever calling writeContract, which
  // is the entire point: a guaranteed on-chain revert burns gas, and
  // `authorizationState` is too eventually-consistent to catch the
  // duplicate before broadcast.
  const key = inFlightKey(auth.from, auth.nonce);
  if (inFlightNonces.has(key)) {
    return {
      response: buildSettleFailure(
        network,
        "invalid_transaction_state",
        auth.from,
      ),
      gasSpentWei: null,
    };
  }
  inFlightNonces.add(key);

  try {
    let v: number;
    let r: Hex;
    let s: Hex;
    try {
      ({ v, r, s } = splitSignature(evm.signature));
    } catch {
      return {
        response: buildSettleFailure(network, "invalid_payload", auth.from),
        gasSpentWei: null,
      };
    }

    let txHash: Hex;
    try {
      txHash = await walletClient.writeContract({
        account,
        chain: CHAIN_BY_NETWORK[network],
        address: USDC_ADDRESS[network],
        abi: USDC_ABI,
        functionName: "transferWithAuthorization",
        args: [
          auth.from as Address,
          auth.to as Address,
          BigInt(auth.value),
          BigInt(auth.validAfter),
          BigInt(auth.validBefore),
          auth.nonce as Hex,
          v,
          r,
          s,
        ],
      });
    } catch {
      return {
        response: buildSettleFailure(
          network,
          "unexpected_settle_error",
          auth.from,
        ),
        gasSpentWei: null,
      };
    }

    // Wait for inclusion to confirm settlement and capture gas spent.
    let gasSpentWei: bigint | null = null;
    try {
      const receipt = await publicClient.waitForTransactionReceipt({
        hash: txHash,
      });
      if (receipt.status !== "success") {
        return {
          response: buildSettleFailure(
            network,
            "unexpected_settle_error",
            auth.from,
          ),
          gasSpentWei: null,
        };
      }
      gasSpentWei =
        BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice ?? 0);
    } catch {
      // Transaction was broadcast but inclusion wait failed. Surface the hash
      // so the caller can poll independently rather than re-broadcasting and
      // burning the nonce twice.
      return {
        response: {
          success: true,
          network,
          transaction: txHash,
          payer: auth.from,
        },
        gasSpentWei: null,
      };
    }

    return {
      response: {
        success: true,
        network,
        transaction: txHash,
        payer: auth.from,
      },
      gasSpentWei,
    };
  } finally {
    inFlightNonces.delete(key);
  }
}

function verifyReasonToSettleReason(
  reason: VerifyResponse["invalidReason"],
): SettleResponse["errorReason"] {
  // The two error enums are unified in upstream x402, so the verify reason
  // is already a valid settle errorReason. The cast is a structural no-op.
  return reason as SettleResponse["errorReason"];
}
