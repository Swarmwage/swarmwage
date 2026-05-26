// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Swarmwage
//
// Tool definitions exposed to the agent's LLM. Same definitions across
// providers (Anthropic, OpenAI, Google, Mistral, ...).

import { tool } from 'ai';
import { z } from 'zod';
import type { LocalAccount } from 'viem';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  searchAgents,
  publishListing,
  hireAgent,
  listMyListings,
} from './sdk-bridge.js';
import { recordListedPrice } from './price-registry.js';
import { COMPOUND_TEMPLATES } from '@swarmwage/tournament-shared';

export interface ToolContext {
  agentId: string;
  account: LocalAccount;
  agentAddress: `0x${string}`;
  registryUrl: string;
  rpcUrl: string;
  walletSvcUrl: string;
  leaderboardUrl: string;
  memoryDir: string;
  capabilityPrefix: string;
  /** Publicly addressable URL this agent's seller surface lives at. */
  myEndpointBase: string; // e.g. https://tournament.swarmwage.com/agent/agent_01
  /** Max single-hire price cap (USDC, decimal string). Defensive against an agent burning its budget on a single bad call. */
  maxSingleHireUsdc: string;
}

async function getJson<T = unknown>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return (await res.json()) as T;
}

export function buildTools(ctx: ToolContext) {
  return {
    search_agents: tool({
      description:
        'Search the Swarmwage registry for agents offering a capability. Returns up to 20 listings with prices, endpoints, reputation, latency stats.',
      parameters: z.object({
        capability: z.string().describe('Capability ID prefix, e.g. "text.summarize" or "code".'),
        max_price_usdc: z.string().optional().describe('Filter to listings at or below this price, e.g. "0.50".'),
        max_latency_ms: z.number().optional(),
      }),
      execute: async ({ capability, max_price_usdc, max_latency_ms }) =>
        searchAgents({
          registryUrl: ctx.registryUrl,
          capability,
          max_price_usdc,
          max_latency_ms,
        }),
    }),

    list_capabilities: tool({
      description: 'Browse the protocol capability taxonomy.',
      parameters: z.object({}),
      execute: async () => getJson(`${ctx.registryUrl}/v1/capabilities`),
    }),

    check_reputation: tool({
      description: "Look up an agent's reputation stats — success rate, latency p50/p95, dispute rate, 24h volume.",
      parameters: z.object({ agent_id: z.string().describe('Lowercase 0x address.') }),
      execute: async ({ agent_id }) =>
        getJson(`${ctx.registryUrl}/v1/agents/${agent_id}/reputation`),
    }),

    hire_agent: tool({
      description: 'Hire another agent for a specific capability. Pays USDC via x402. Returns the seller-delivered payload.',
      parameters: z.object({
        capability: z.string(),
        params: z.record(z.unknown()).describe("The capability input payload."),
        max_price_usdc: z.string().describe('Refuse to spend more than this many USDC, e.g. "0.10".'),
        seller_agent_id: z.string().optional().describe('Force a specific seller; otherwise picks the top match.'),
      }),
      execute: async ({ capability, params, max_price_usdc, seller_agent_id }) => {
        // Defensive cap: never exceed the agent's per-hire ceiling
        if (parseFloat(max_price_usdc) > parseFloat(ctx.maxSingleHireUsdc)) {
          return {
            error: `max_price_usdc ${max_price_usdc} exceeds per-hire ceiling ${ctx.maxSingleHireUsdc}`,
          };
        }
        try {
          return await hireAgent({
            account: ctx.account,
            registryUrl: ctx.registryUrl,
            rpcUrl: ctx.rpcUrl,
            capability,
            params,
            max_price_usdc,
            seller_agent_id,
          });
        } catch (e) {
          return { error: String(e) };
        }
      },
    }),

    publish_listing: tool({
      description:
        'Publish a capability to the registry. Other agents can hire you for it. Your container will receive payloads at /capabilities/<capability_name>.',
      parameters: z.object({
        capability: z
          .string()
          .describe(
            'Capability name. Must start with the tournament namespace prefix from the system prompt.',
          ),
        price_usdc: z.string().describe('Price per call in USDC, decimal string, e.g. "0.05".'),
        max_latency_ms: z.number().int().positive(),
        first_call_free: z.boolean().optional(),
      }),
      execute: async ({ capability, price_usdc, max_latency_ms, first_call_free }) => {
        // Allow either the tournament-namespaced prefix OR the canonical
        // `compound.*` family (so the LLM can re-price compound listings).
        const isCompound = capability.startsWith('compound.');
        if (!capability.startsWith(ctx.capabilityPrefix) && !isCompound) {
          return {
            error: `capability must start with "${ctx.capabilityPrefix}" or "compound.". Received: "${capability}"`,
          };
        }
        try {
          const endpoint = `${ctx.myEndpointBase}/capabilities/${encodeURIComponent(capability)}`;
          const listing = await publishListing({
            account: ctx.account,
            registryUrl: ctx.registryUrl,
            capability,
            price_usdc,
            endpoint,
            max_latency_ms,
            first_call_free,
          });
          // Make the price enforceable by the seller paywall (index.ts).
          recordListedPrice(capability, price_usdc, !!first_call_free);
          return listing;
        } catch (e) {
          return { error: String(e) };
        }
      },
    }),

    list_my_listings: tool({
      description: 'Show your currently active listings.',
      parameters: z.object({}),
      execute: async () =>
        listMyListings({ registryUrl: ctx.registryUrl, agentId: ctx.agentAddress }),
    }),

    check_my_balance: tool({
      description: 'Your current USDC balance on Base mainnet.',
      parameters: z.object({}),
      execute: async () => {
        const res = await fetch(`${ctx.walletSvcUrl}/wallets/${ctx.agentId}/balance`);
        return res.json();
      },
    }),

    leaderboard: tool({
      description: "Current tournament standings — every agent's USDC balance + recent activity.",
      parameters: z.object({}),
      execute: async () => getJson(`${ctx.leaderboardUrl}/api/leaderboard`),
    }),

    inspect_compound_market: tool({
      description:
        'Inspect the current compound.* market: for each of the 5 compound templates, returns the live registry listings (price, seller, success_rate), plus the template metadata (buyer band, components, delivery window). Use this to decide whether to enter that market as a broker.',
      parameters: z.object({}),
      execute: async () => {
        const byTemplate = await Promise.all(
          COMPOUND_TEMPLATES.map(async (template) => {
            try {
              const listings = await searchAgents({
                registryUrl: ctx.registryUrl,
                capability: template.name,
                limit: 20,
              });
              const summary = listings.map((l) => ({
                seller_agent_id: l.agent_id,
                price_usdc: l.listing.price_usdc,
                max_latency_ms: l.listing.max_latency_ms,
                success_rate: l.reputation.success_rate,
                avg_latency_ms: l.reputation.avg_latency_ms,
                last_30d_hire_count: l.reputation.last_30d_hire_count,
              }));
              return {
                template: template.name,
                label: template.label,
                components: template.components,
                buyer_min_usdc: template.buyer_min_usdc,
                buyer_max_usdc: template.buyer_max_usdc,
                delivery_window_s: template.delivery_window_s,
                listing_count: summary.length,
                listings: summary,
              };
            } catch (e) {
              return {
                template: template.name,
                label: template.label,
                components: template.components,
                buyer_min_usdc: template.buyer_min_usdc,
                buyer_max_usdc: template.buyer_max_usdc,
                delivery_window_s: template.delivery_window_s,
                listing_count: 0,
                listings: [],
                error: String(e),
              };
            }
          }),
        );
        return { templates: byTemplate };
      },
    }),

    recent_market_activity: tool({
      description: 'Last 50 hires in the tournament — who hired whom for what capability at what price.',
      parameters: z.object({}),
      execute: async () => getJson(`${ctx.leaderboardUrl}/api/activity`),
    }),

    note_to_self: tool({
      description: 'Append a note to your private memory. Persists across ticks.',
      parameters: z.object({ text: z.string() }),
      execute: async ({ text }) => {
        const path = `${ctx.memoryDir}/notes.jsonl`;
        if (!existsSync(ctx.memoryDir)) await mkdir(ctx.memoryDir, { recursive: true });
        await mkdir(dirname(path), { recursive: true }).catch(() => {});
        const line = JSON.stringify({ ts: new Date().toISOString(), text }) + '\n';
        await writeFile(path, line, { flag: 'a' });
        return { saved: true };
      },
    }),

    read_my_notes: tool({
      description: 'Read your private memory (last 100 notes).',
      parameters: z.object({}),
      execute: async () => {
        const path = `${ctx.memoryDir}/notes.jsonl`;
        if (!existsSync(path)) return { notes: [] };
        const lines = (await readFile(path, 'utf-8')).trim().split('\n').slice(-100);
        return { notes: lines.map((l) => JSON.parse(l)) };
      },
    }),
  };
}
