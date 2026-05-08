// Swarmwage Indexer — USDC contract addresses + Transfer event ABI fragment
// License: BUSL-1.1
//
// The indexer is read-only. It subscribes to the standard ERC-20 `Transfer`
// event emitted by the USDC contract on the configured network and decodes
// the (from, to, value) tuple. No write methods are imported here, and the
// service holds no signing key.

import type { Address } from "viem";

import type { IndexerNetwork } from "./env.js";

/**
 * USDC contract addresses for the supported networks.
 *
 * - Base mainnet:  `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` (native USDC)
 * - Base sepolia:  `0x036CbD53842c5426634e7929541eC2318f3dCF7e` (testnet USDC)
 */
export const USDC_ADDRESS: Record<IndexerNetwork, Address> = {
  base: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  "base-sepolia": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
};

/**
 * The standard ERC-20 `Transfer` event. USDC is fully ERC-20 compliant on
 * both Base mainnet and Base sepolia, so this minimal fragment is all the
 * indexer needs to decode `eth_getLogs` results.
 */
export const TRANSFER_EVENT = {
  type: "event",
  name: "Transfer",
  inputs: [
    { name: "from", type: "address", indexed: true },
    { name: "to", type: "address", indexed: true },
    { name: "value", type: "uint256", indexed: false },
  ],
  anonymous: false,
} as const;

/** USDC has six decimals; one atomic unit equals 1e-6 USDC. */
export const USDC_DECIMALS = 6;
