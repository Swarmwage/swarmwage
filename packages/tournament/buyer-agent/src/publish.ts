// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Swarmwage
//
// Search + hire wire to the Swarmwage protocol for the buyer.
//
// Mirrors `packages/tournament/agent-runner/src/sdk-bridge.ts` but exposes
// only the read + hire surface (the buyer never publishes listings, never
// submits receipts — it only spends).

import {
  createWalletClient,
  http,
  parseUnits,
  type LocalAccount,
} from 'viem';
import { base } from 'viem/chains';
import { wrapFetchWithPayment } from 'x402-fetch';
import {
  PROTOCOL_VERSION,
  type SearchResultEntry,
  SWARMWAGE_FACILITATOR_HEADER,
  SWARMWAGE_FACILITATOR_URL,
} from '@swarmwage/agent-sdk';
import type {
  CompoundTemplate,
  SimpleCapability,
} from '@swarmwage/tournament-shared';
import type { MarketSummary, PickedSeller } from './types.js';

const DEFAULT_LIMIT = 20;

function buildPaidFetch(
  account: LocalAccount,
  rpcUrl: string,
  maxAtomic: bigint,
): typeof fetch {
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

export async function searchCapability(args: {
  registryUrl: string;
  capability: string;
  max_price_usdc?: string;
  max_latency_ms?: number;
  limit?: number;
}): Promise<SearchResultEntry[]> {
  const res = await fetch(`${args.registryUrl}/v1/search`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      capability: args.capability,
      max_price_usdc: args.max_price_usdc,
      max_latency_ms: args.max_latency_ms,
      limit: args.limit ?? DEFAULT_LIMIT,
    }),
  });
  if (!res.ok) {
    throw new Error(`search ${args.capability} ${res.status}: ${await res.text()}`);
  }
  const data = (await res.json()) as { agents: SearchResultEntry[] };
  return data.agents;
}

/**
 * Build a snapshot of the compound-listing market: per-template how many
 * sellers exist and the cheapest price. Surfaced to the LLM each tick so
 * it can pick the best template to demand.
 */
export async function buildMarketSummary(args: {
  registryUrl: string;
  templates: readonly CompoundTemplate[];
}): Promise<MarketSummary> {
  const listings: Record<string, number> = {};
  const minPrice: Record<string, string | null> = {};

  await Promise.all(
    args.templates.map(async (t) => {
      try {
        const results = await searchCapability({
          registryUrl: args.registryUrl,
          capability: t.name,
          limit: DEFAULT_LIMIT,
        });
        listings[t.name] = results.length;
        if (results.length === 0) {
          minPrice[t.name] = null;
        } else {
          const sorted = [...results].sort(
            (a, b) =>
              parseFloat(a.listing.price_usdc) - parseFloat(b.listing.price_usdc),
          );
          minPrice[t.name] = sorted[0].listing.price_usdc;
        }
      } catch {
        listings[t.name] = 0;
        minPrice[t.name] = null;
      }
    }),
  );

  return { template_listings: listings, template_min_price_usdc: minPrice };
}

/**
 * Pick the best seller for a compound template: cheapest first, breaking
 * ties by best reputation (success_rate) when present. The buyer is
 * cost-sensitive — it has only $10 to spread across the tournament.
 */
export async function pickSellerForTemplate(args: {
  registryUrl: string;
  template: CompoundTemplate;
  max_price_usdc: string;
}): Promise<PickedSeller | null> {
  const results = await searchCapability({
    registryUrl: args.registryUrl,
    capability: args.template.name,
    max_price_usdc: args.max_price_usdc,
    max_latency_ms: args.template.delivery_window_s * 1000,
    limit: DEFAULT_LIMIT,
  });
  if (results.length === 0) return null;

  const sorted = [...results].sort((a, b) => {
    const priceDiff =
      parseFloat(a.listing.price_usdc) - parseFloat(b.listing.price_usdc);
    if (priceDiff !== 0) return priceDiff;
    const aRate =
      (a.reputation as { success_rate?: number } | undefined)?.success_rate ?? 0;
    const bRate =
      (b.reputation as { success_rate?: number } | undefined)?.success_rate ?? 0;
    return bRate - aRate;
  });

  const top = sorted[0];
  return {
    agent_id: top.agent_id,
    endpoint: top.listing.endpoint,
    price_usdc: top.listing.price_usdc,
  };
}

/**
 * Hire a seller for a compound order. Settles via x402 + EIP-3009 through
 * the buyer's wallet-svc-backed account.
 *
 * `params` is the per-template payload the buyer ships to the seller's
 * `POST {endpoint}/hire`. The seller (an internal tournament agent acting
 * as broker) is responsible for sub-hiring component capabilities and
 * returning the aggregated artifact bundle.
 */
export async function hireCompound(args: {
  account: LocalAccount;
  rpcUrl: string;
  facilitatorUrl?: string | null;
  seller: PickedSeller;
  template: CompoundTemplate;
  topic: string;
  max_price_usdc: string;
}): Promise<unknown> {
  const facilitatorUrl =
    args.facilitatorUrl === null
      ? null
      : args.facilitatorUrl ?? SWARMWAGE_FACILITATOR_URL;
  const maxAtomic = parseUnits(args.max_price_usdc, 6);
  const paidFetch = buildPaidFetch(args.account, args.rpcUrl, maxAtomic);

  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (facilitatorUrl) headers[SWARMWAGE_FACILITATOR_HEADER] = facilitatorUrl;

  const brief = args.template.brief_template.replace(/\{\{TOPIC\}\}/g, args.topic);
  const params = {
    template: args.template.name,
    topic: args.topic,
    brief,
    components: args.template.components as readonly SimpleCapability[],
    output_schema: args.template.output_schema,
    delivery_window_s: args.template.delivery_window_s,
  };

  const url = `${args.seller.endpoint.replace(/\/$/, '')}/hire`;
  const res = await paidFetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      protocol: PROTOCOL_VERSION,
      buyer_id: args.account.address.toLowerCase(),
      capability: args.template.name,
      params,
      max_price_usdc: args.max_price_usdc,
      max_latency_ms: args.template.delivery_window_s * 1000,
      callback_url: null,
      nonce: crypto.randomUUID(),
    }),
  });
  if (!res.ok) {
    throw new Error(`hire ${args.template.name} ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

export async function fetchBalanceUsdc(args: {
  walletSvcUrl: string;
  buyerId: string;
}): Promise<number> {
  const token = process.env.WALLET_SVC_TOKEN;
  const res = await fetch(
    `${args.walletSvcUrl.replace(/\/$/, '')}/wallets/${args.buyerId}/balance`,
    token ? { headers: { authorization: `Bearer ${token}` } } : undefined,
  );
  if (!res.ok) {
    throw new Error(`balance ${res.status}: ${await res.text()}`);
  }
  const data = (await res.json()) as { balance_usdc?: string; usdc?: string };
  const raw = data.balance_usdc ?? data.usdc ?? '0';
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n : 0;
}
