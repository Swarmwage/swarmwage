// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Swarmwage
//
// Real wire to the Swarmwage protocol. Mirrors `AgentClient` from
// @swarmwage/agent-sdk but uses a remote (sidecar-backed) viem account
// for signing instead of an in-process private key.
//
// Re-implementing rather than monkey-patching the SDK keeps the SDK
// unchanged for other consumers. A follow-up SDK feature to accept a
// pre-built account is tracked separately.

import { createWalletClient, http, keccak256, toBytes, parseUnits, type LocalAccount } from 'viem';
import { base } from 'viem/chains';
import { wrapFetchWithPayment } from 'x402-fetch';
import {
  PROTOCOL_VERSION,
  type Listing,
  type SearchResultEntry,
  signReceipt,
  type ReceiptPayload,
  SWARMWAGE_FACILITATOR_HEADER,
  SWARMWAGE_FACILITATOR_URL,
} from '@swarmwage/agent-sdk';

const DEFAULT_REGISTRY_URL = 'https://api.swarmwage.com';
const DEFAULT_RPC_URL = 'https://mainnet.base.org';

/**
 * Build a fetch client that auto-pays x402 challenges using a remote viem
 * account. Each call is capped at `maxAtomic` USDC atomic units (1e6 = 1 USDC).
 */
function buildPaidFetch(account: LocalAccount, rpcUrl: string, maxAtomic: bigint) {
  const walletClient = createWalletClient({
    account,
    chain: base,
    transport: http(rpcUrl),
  });
  return wrapFetchWithPayment(
    globalThis.fetch,
    walletClient as unknown as Parameters<typeof wrapFetchWithPayment>[1],
    maxAtomic,
  ) as unknown as typeof fetch;
}

// ---------------------------------------------------------------------------
// Search

export interface SearchArgs {
  registryUrl?: string;
  capability: string;
  max_price_usdc?: string;
  max_latency_ms?: number;
  limit?: number;
}

export async function searchAgents(args: SearchArgs): Promise<SearchResultEntry[]> {
  const url = `${args.registryUrl ?? DEFAULT_REGISTRY_URL}/v1/search`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      capability: args.capability,
      max_price_usdc: args.max_price_usdc,
      max_latency_ms: args.max_latency_ms,
      limit: args.limit ?? 10,
    }),
  });
  if (!res.ok) throw new Error(`search ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { agents: SearchResultEntry[] };
  return data.agents;
}

// ---------------------------------------------------------------------------
// Publish listing — signed canonically via the remote account

export interface PublishArgs {
  account: LocalAccount;
  registryUrl?: string;
  capability: string;
  price_usdc: string;
  endpoint: string;
  max_latency_ms: number;
  first_call_free?: boolean;
}

export async function publishListing(args: PublishArgs): Promise<Listing> {
  const partial = {
    agent_id: args.account.address.toLowerCase() as `0x${string}`,
    capability: args.capability,
    price_usdc: args.price_usdc,
    currency: 'USDC' as const,
    chain: 'base' as const,
    max_latency_ms: args.max_latency_ms,
    first_call_free: args.first_call_free ?? false,
    endpoint: args.endpoint,
  };
  // Mirror SDK signTypedPayload: canonical JSON (sorted keys) → keccak256 → personalSign
  const canonical = JSON.stringify(partial, Object.keys(partial).sort());
  const hash = keccak256(toBytes(canonical));
  const signature = await args.account.signMessage({ message: { raw: hash } });

  const signed: Listing = { ...partial, signature };
  const url = `${args.registryUrl ?? DEFAULT_REGISTRY_URL}/v1/listings`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(signed),
  });
  if (!res.ok) throw new Error(`publish ${res.status}: ${await res.text()}`);
  return signed;
}

// ---------------------------------------------------------------------------
// Hire — pays the seller's x402 challenge using the remote account

export interface HireArgs {
  account: LocalAccount;
  registryUrl?: string;
  rpcUrl?: string;
  facilitatorUrl?: string | null;
  capability: string;
  params: Record<string, unknown>;
  max_price_usdc: string;
  max_latency_ms?: number;
  /** Pre-resolved seller (skip search if provided). */
  seller_agent_id?: string;
  endpoint?: string;
}

export async function hireAgent(args: HireArgs): Promise<unknown> {
  let endpoint = args.endpoint;
  let sellerId = args.seller_agent_id;
  if (!endpoint) {
    const candidates = await searchAgents({
      registryUrl: args.registryUrl,
      capability: args.capability,
      max_price_usdc: args.max_price_usdc,
      max_latency_ms: args.max_latency_ms,
      limit: sellerId ? 50 : 1,
    });
    const top = sellerId
      ? candidates.find((c) => c.agent_id === sellerId)
      : candidates[0];
    if (!top) throw new Error(`no listings found for ${args.capability}`);
    sellerId = top.agent_id;
    endpoint = top.listing.endpoint;
  }

  const facilitatorUrl =
    args.facilitatorUrl === null ? null : args.facilitatorUrl ?? SWARMWAGE_FACILITATOR_URL;

  const maxAtomic = parseUnits(args.max_price_usdc, 6);
  const paidFetch = buildPaidFetch(args.account, args.rpcUrl ?? DEFAULT_RPC_URL, maxAtomic);

  // Hire requests POST to the seller's endpoint with /hire appended (mirrors
  // the SDK's AgentClient.hire flow). Settlement happens via x402 handshake;
  // the registry is NOT in the data path.
  const url = `${endpoint!.replace(/\/$/, '')}/hire`;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (facilitatorUrl) headers[SWARMWAGE_FACILITATOR_HEADER] = facilitatorUrl;

  const res = await paidFetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      protocol: PROTOCOL_VERSION,
      buyer_id: args.account.address.toLowerCase(),
      capability: args.capability,
      params: args.params,
      max_price_usdc: args.max_price_usdc,
      max_latency_ms: args.max_latency_ms,
      callback_url: null,
      nonce: crypto.randomUUID(),
    }),
  });
  if (!res.ok) throw new Error(`hire ${res.status}: ${await res.text()}`);
  return res.json();
}

// ---------------------------------------------------------------------------
// Submit receipt (seller-side, after fulfilling a hire)

export interface SubmitReceiptArgs {
  account: LocalAccount;
  registryUrl?: string;
  payload: Omit<ReceiptPayload, 'agent_id'>;
}

export async function submitReceipt(args: SubmitReceiptArgs): Promise<unknown> {
  const payload: ReceiptPayload = {
    ...args.payload,
    agent_id: args.account.address.toLowerCase() as `0x${string}`,
  };
  // Use SDK's signReceipt to keep the canonical-JSON-keccak256 in one place.
  // signReceipt expects an AgentWallet shape, so we build a minimal adapter.
  const wallet = {
    agentId: payload.agent_id,
    account: args.account,
    signMessage: (m: string) => args.account.signMessage({ message: m }),
    signTypedPayload: async (p: object) => {
      const canonical = JSON.stringify(p, Object.keys(p).sort());
      const hash = keccak256(toBytes(canonical));
      return args.account.signMessage({ message: { raw: hash } });
    },
  } as Parameters<typeof signReceipt>[0];

  const { body } = await signReceipt(wallet, payload);
  const url = `${args.registryUrl ?? DEFAULT_REGISTRY_URL}/v1/receipts`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`receipt ${res.status}: ${await res.text()}`);
  return res.json();
}

// ---------------------------------------------------------------------------
// Read-only listing introspection

export async function listMyListings(args: { registryUrl?: string; agentId: string }): Promise<Listing[]> {
  const url = `${args.registryUrl ?? DEFAULT_REGISTRY_URL}/v1/agents/${args.agentId}/listings`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`listMyListings ${res.status}`);
  const data = (await res.json()) as { listings: Listing[] };
  return data.listings;
}
