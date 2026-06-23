// Swarmwage Agent SDK — wallet utilities
// Wraps viem for signing operations.
// License: MIT

import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { keccak256, toBytes } from "viem";
import { canonicalize } from "./canonical.js";
import type { AgentId, Hex } from "./types.js";

export interface WalletConfig {
  /** 0x-prefixed 32-byte private key. */
  privateKey: Hex;
}

export interface AgentWallet {
  agentId: AgentId;
  /** Underlying viem account — used to construct a WalletClient for x402. */
  account: PrivateKeyAccount;
  signMessage: (message: string) => Promise<Hex>;
  signTypedPayload: (payload: object) => Promise<Hex>;
}

/**
 * Build an AgentWallet from a private key.
 *
 * The agent ID is derived from the wallet address (lowercase, 0x-prefixed).
 */
export function createWallet({ privateKey }: WalletConfig): AgentWallet {
  const account = privateKeyToAccount(privateKey);
  const agentId = account.address.toLowerCase() as AgentId;

  return {
    agentId,
    account,
    signMessage: async (message: string): Promise<Hex> => {
      return account.signMessage({ message });
    },
    signTypedPayload: async (payload: object): Promise<Hex> => {
      // Canonicalize (recursive, nested fields covered), keccak256, sign as hex.
      const canonical = canonicalize(payload);
      const hash = keccak256(toBytes(canonical));
      return account.signMessage({ message: { raw: hash } });
    },
  };
}
