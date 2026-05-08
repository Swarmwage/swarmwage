// Swarmwage Indexer — viem public client factory
// License: BUSL-1.1
//
// We intentionally expose only a `PublicClient` — the indexer never holds
// a signing key and never broadcasts transactions. There is no
// `WalletClient` and no private-key configuration in this package.

import { createPublicClient, http } from "viem";
import { base, baseSepolia } from "viem/chains";

import type { IndexerNetwork } from "./env.js";

// viem produces chain-specific Client types whose static shapes diverge
// across OP-Stack chains. Runtime behaviour is identical for our purposes
// (we only call `getBlockNumber`, `getBlock`, and `getLogs`). We accept
// `any` here to avoid the generic explosion when the same module needs
// to support multiple chains.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type PublicClientLike = any;

const CHAIN_BY_NETWORK = {
  base,
  "base-sepolia": baseSepolia,
} as const;

export interface ChainContext {
  readonly network: IndexerNetwork;
  readonly chainId: number;
  readonly publicClient: PublicClientLike;
}

export function createChainContext(args: {
  network: IndexerNetwork;
  rpcUrl: string | undefined;
}): ChainContext {
  const chain = CHAIN_BY_NETWORK[args.network];
  const transport = http(args.rpcUrl);
  const publicClient = createPublicClient({ chain, transport });
  return {
    network: args.network,
    chainId: chain.id,
    publicClient,
  };
}
