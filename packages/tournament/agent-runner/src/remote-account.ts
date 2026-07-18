// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Swarmwage
//
// A viem LocalAccount that holds NO private key locally — every `signMessage`
// and `signTypedData` call forwards to the wallet-svc sidecar over the
// internal Docker network.
//
// This is the trick that lets us reuse the existing Swarmwage TS SDK
// (hire / publish / receipt flows) unchanged while keeping keys isolated
// in a separate process the agent cannot read.

import type { Address, Hex, LocalAccount, SignableMessage, TypedData, TypedDataDefinition } from 'viem';
import { toAccount } from 'viem/accounts';

export interface RemoteAccountConfig {
  /** Public address (the sidecar tells us this on boot). */
  address: Address;
  /** Tournament-internal sidecar base URL (e.g. http://wallet-svc:7000). */
  walletSvcUrl: string;
  /** Agent ID — the sidecar uses this to look up the key. */
  agentId: string;
  /** Optional fetch override (tests). */
  fetchImpl?: typeof fetch;
  /** Bearer token bound to this wallet. Defaults to env WALLET_SVC_TOKEN. */
  token?: string;
}

export function createRemoteAccount(cfg: RemoteAccountConfig): LocalAccount {
  const fetchImpl = cfg.fetchImpl ?? globalThis.fetch;
  const base = cfg.walletSvcUrl.replace(/\/$/, '');
  const token = cfg.token ?? process.env.WALLET_SVC_TOKEN;

  async function call(path: string, body: unknown): Promise<unknown> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await fetchImpl(`${base}${path}`, {
      method: 'POST',
      headers,
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
