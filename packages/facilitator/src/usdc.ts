// Swarmwage Facilitator — USDC contract addresses + ABI fragment
// License: BUSL-1.1
//
// Only the slice of the USDC ABI required to broadcast a signed
// `transferWithAuthorization` (EIP-3009) is included here. The facilitator
// never invokes any other USDC function — it cannot mint, burn, transfer,
// or approve on behalf of any account other than what the signed
// authorization explicitly permits (buyer → seller).

import type { Address, Hex } from "viem";

import type { FacilitatorNetwork } from "./env.js";

/**
 * USDC contract addresses for the supported networks.
 *
 * - Base mainnet:  `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` (native USDC)
 * - Base sepolia:  `0x036CbD53842c5426634e7929541eC2318f3dCF7e` (testnet USDC)
 */
export const USDC_ADDRESS: Record<FacilitatorNetwork, Address> = {
  base: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  "base-sepolia": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
};

/**
 * Minimal USDC ABI: only the functions we need to broadcast signed EIP-3009
 * authorizations and to inspect authorization state.
 */
export const USDC_ABI = [
  {
    type: "function",
    name: "transferWithAuthorization",
    stateMutability: "nonpayable",
    inputs: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" },
      { name: "v", type: "uint8" },
      { name: "r", type: "bytes32" },
      { name: "s", type: "bytes32" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "authorizationState",
    stateMutability: "view",
    inputs: [
      { name: "authorizer", type: "address" },
      { name: "nonce", type: "bytes32" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "version",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "string" }],
  },
  {
    type: "function",
    name: "name",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "string" }],
  },
] as const;

/**
 * EIP-712 domain for USDC `transferWithAuthorization` on the supported
 * networks. The `name`/`version` here MUST match the values returned by the
 * deployed USDC contract; both Base mainnet and Base sepolia USDC report
 * `name = "USD Coin"` and `version = "2"`.
 */
export function usdcEip712Domain(
  network: FacilitatorNetwork,
  chainId: number,
) {
  return {
    name: "USD Coin",
    version: "2",
    chainId,
    verifyingContract: USDC_ADDRESS[network],
  } as const;
}

/**
 * EIP-3009 typed-data definition for `transferWithAuthorization`.
 */
export const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

/**
 * Convert a 65-byte EVM signature to its (v, r, s) split as required by the
 * legacy `transferWithAuthorization(...,v,r,s)` overload.
 */
export function splitSignature(signature: Hex): { v: number; r: Hex; s: Hex } {
  const sig = signature.startsWith("0x") ? signature.slice(2) : signature;
  if (sig.length !== 130) {
    throw new Error(
      `expected 65-byte signature (130 hex chars), got ${sig.length}`,
    );
  }
  const r = `0x${sig.slice(0, 64)}` as Hex;
  const s = `0x${sig.slice(64, 128)}` as Hex;
  let v = parseInt(sig.slice(128, 130), 16);
  // EIP-155 normalised values arrive as 27 / 28; any other value (e.g. 0/1
  // from a fresh ECDSA recovery) is bumped into the canonical range.
  if (v < 27) v += 27;
  return { v, r, s };
}
