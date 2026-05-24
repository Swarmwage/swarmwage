// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Swarmwage
//
// viem LocalAccount that forwards every signing call to the wallet-svc
// sidecar over the internal Docker network. The buyer process never sees
// the private key.
//
// Mirrors `packages/tournament/agent-runner/src/remote-account.ts`. Kept as
// a local copy (rather than a shared package import) to keep the buyer's
// dependency surface minimal and the build context tight for Docker.

import type { Address, Hex, LocalAccount } from 'viem';
import { toAccount } from 'viem/accounts';

export interface RemoteAccountConfig {
  address: Address;
  walletSvcUrl: string;
  agentId: string;
  fetchImpl?: typeof fetch;
}

export function createRemoteAccount(cfg: RemoteAccountConfig): LocalAccount {
  const fetchImpl = cfg.fetchImpl ?? globalThis.fetch;
  const base = cfg.walletSvcUrl.replace(/\/$/, '');

  async function call(path: string, body: unknown): Promise<unknown> {
    const res = await fetchImpl(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`wallet-svc returned non-JSON (${res.status}): ${text.slice(0, 200)}`);
    }
    if (!res.ok) {
      throw new Error(`wallet-svc ${res.status}: ${text.slice(0, 200)}`);
    }
    return parsed;
  }

  return toAccount({
    address: cfg.address,
    async signMessage({ message }) {
      const r = (await call(`/wallets/${cfg.agentId}/sign-message`, { message })) as {
        signature: Hex;
      };
      return r.signature;
    },
    async signTypedData(parameters) {
      const r = (await call(`/wallets/${cfg.agentId}/sign-typed-data`, parameters)) as {
        signature: Hex;
      };
      return r.signature;
    },
    async signTransaction() {
      throw new Error(
        'remote account does not support signTransaction — use x402/EIP-3009 typed-data signing instead',
      );
    },
  });
}
