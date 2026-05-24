// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Swarmwage
//
// Per-agent runtime. One container per agent.
//
// Two concurrent roles:
//   1. **Strategist / buyer** — every TICK_INTERVAL_MS, calls the LLM with the
//      tool surface and executes its tool calls.
//   2. **Seller** — Hono server on :3000 with a route per published capability;
//      incoming hires generate deliverables by calling the same LLM.

import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { generateText } from 'ai';
import { existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { createRemoteAccount } from './remote-account.js';
import { pickModel, resolveLanguageModel } from './llm.js';
import { buildTools, type ToolContext } from './tools.js';
import { buildSystemPrompt } from './system-prompt.js';
import { publishListing, submitReceipt } from './sdk-bridge.js';
import { fulfillCompound } from './compound.js';
import {
  COMPOUND_TEMPLATES,
  estimateComponentCost,
  templateByName,
  type CompoundTemplate,
  type SimpleCapability,
} from '@swarmwage/tournament-shared';

const AGENT_ID = required('AGENT_ID');
const WALLET_SVC_URL = required('WALLET_SVC_URL');
const REGISTRY_URL = process.env.REGISTRY_URL ?? 'https://api.swarmwage.com';
const RPC_URL = process.env.RPC_URL ?? 'https://mainnet.base.org';
const LEADERBOARD_URL = process.env.LEADERBOARD_URL ?? 'https://tournament.swarmwage.com';
const TOURNAMENT_START = required('TOURNAMENT_START_ISO');
const TOURNAMENT_END = required('TOURNAMENT_END_ISO');
const CAPABILITY_PREFIX = process.env.CAPABILITY_PREFIX ?? `tournament.${TOURNAMENT_START.slice(0, 10)}.`;
const MY_ENDPOINT_BASE = process.env.MY_ENDPOINT_BASE ?? `${LEADERBOARD_URL}/agent/${AGENT_ID}`;
const TICK_INTERVAL_MS = Number(process.env.TICK_INTERVAL_MS ?? 2 * 60 * 1000);
const MAX_API_USD = Number(process.env.MAX_API_USD ?? 8);
const MAX_SINGLE_HIRE_USDC = process.env.MAX_SINGLE_HIRE_USDC ?? '0.50';
const STARTING_BALANCE_USDC = process.env.STARTING_BALANCE_USDC ?? '5';
const N_AGENTS = Number(process.env.N_AGENTS ?? 10);
const PRIMARY_CAPABILITY = process.env.PRIMARY_CAPABILITY ?? '';
const COMPOUND_AUTO_PUBLISH = (process.env.COMPOUND_AUTO_PUBLISH ?? 'true').toLowerCase() !== 'false';
const COMPOUND_PER_COMPONENT_USDC = Number(process.env.COMPOUND_PER_COMPONENT_USDC ?? 0.10);
const COMPOUND_MARGIN_MULT = Number(process.env.COMPOUND_MARGIN_MULT ?? 1.5);
const COMPOUND_MAX_LATENCY_MS = Number(process.env.COMPOUND_MAX_LATENCY_MS ?? 60_000);
const MEMORY_DIR = process.env.MEMORY_DIR ?? '/agent/memory';
const TICK_LOG = `${MEMORY_DIR}/tick-log.jsonl`;
const PORT = Number(process.env.PORT ?? 3000);

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return v;
}

if (!existsSync(MEMORY_DIR)) mkdirSync(MEMORY_DIR, { recursive: true });

const modelSpec = pickModel(AGENT_ID);
const languageModel = resolveLanguageModel(modelSpec);

(async () => {
  // Resolve our public address from the wallet sidecar
  const addrRes = await fetch(`${WALLET_SVC_URL}/wallets/${AGENT_ID}/address`);
  if (!addrRes.ok) {
    throw new Error(`wallet-svc address lookup ${addrRes.status}`);
  }
  const { address } = (await addrRes.json()) as { address: `0x${string}` };

  const account = createRemoteAccount({
    agentId: AGENT_ID,
    walletSvcUrl: WALLET_SVC_URL,
    address,
  });

  const ctx: ToolContext = {
    agentId: AGENT_ID,
    account,
    agentAddress: address.toLowerCase() as `0x${string}`,
    registryUrl: REGISTRY_URL,
    rpcUrl: RPC_URL,
    walletSvcUrl: WALLET_SVC_URL,
    leaderboardUrl: LEADERBOARD_URL,
    memoryDir: MEMORY_DIR,
    capabilityPrefix: CAPABILITY_PREFIX,
    myEndpointBase: MY_ENDPOINT_BASE,
    maxSingleHireUsdc: MAX_SINGLE_HIRE_USDC,
  };

  const tools = buildTools(ctx);

  const systemPrompt = buildSystemPrompt({
    agent_id: AGENT_ID,
    model_label: modelSpec.label,
    tournament_start_iso: TOURNAMENT_START,
    tournament_end_iso: TOURNAMENT_END,
    starting_balance_usdc: STARTING_BALANCE_USDC,
    n_agents: N_AGENTS,
    wallet_address: address,
  });

  // Seller HTTP surface — receives hire payloads from buyers via x402.
  // The x402-aware buyer's facilitator handles settlement; our role here is
  // to (a) generate a deliverable, (b) submit a signed receipt to the
  // registry so our reputation reflects the work.
  const sellerApp = new Hono();
  sellerApp.get('/health', (c) => c.json({ ok: true, agent_id: AGENT_ID, address }));
  // Route MUST end in `/hire` to match the SDK convention used by every
  // buyer (sdk-bridge + tournament-buyer-agent both POST `${endpoint}/hire`).
  // The published listing endpoint is `${MY_ENDPOINT_BASE}/capabilities/<name>`;
  // the buyer appends `/hire` to it.
  sellerApp.post('/capabilities/:name/hire', async (c) => {
    const cap = c.req.param('name');
    const payload = await c.req.json();
    const buyerAddress = (payload?.buyer_id ?? '0x0').toString().toLowerCase();

    // Branch: compound hires decompose into sub-hires and aggregate, instead
    // of running the LLM. The buyer's payment is already settled via x402
    // (we are inside the seller endpoint); our job is to deliver the bundle.
    const compoundTemplate = cap.startsWith('compound.') ? templateByName(cap) : undefined;
    if (compoundTemplate) {
      const paymentUsdc = parseFloat(
        (payload?.max_price_usdc ?? `${compoundTemplate.buyer_min_usdc}`).toString(),
      );
      const topic =
        (payload?.params?.topic as string | undefined) ??
        (payload?.topic as string | undefined) ??
        'unspecified topic';
      try {
        const result = await fulfillCompound({
          template: compoundTemplate,
          topic,
          payment_usdc: Number.isFinite(paymentUsdc) ? paymentUsdc : compoundTemplate.buyer_min_usdc,
          ctx,
          buyerAddress,
        });
        // Only submit a receipt on full delivery — partial / failed orders
        // leave the buyer with grounds to dispute via the registry.
        if (result.status === 'ok') {
          submitReceipt({
            account,
            registryUrl: REGISTRY_URL,
            payload: {
              protocol_version: 'swarmwage/v0.1',
              hire_id: crypto.randomUUID(),
              buyer: buyerAddress as `0x${string}`,
              capability: cap,
              amount_usdc_atomic: '0',
              network: 'base',
              tx_hash: '0x0',
              completed_at: new Date().toISOString(),
              verification: { all_passed: true, checks: { delivered: true } },
            },
          }).catch((e) => console.error('compound receipt submit failed:', e));
        }
        return c.json({
          compound: true,
          template: compoundTemplate.name,
          status: result.status,
          output: result.output,
          sub_hires: result.sub_hires.map((sh) => ({
            component: sh.component,
            seller_agent_id: sh.seller_agent_id,
            ok: sh.ok,
            spent_usdc: sh.spent_usdc,
            latency_ms: sh.latency_ms,
            error: sh.error,
          })),
          total_spent_usdc: result.total_spent_usdc,
          error: result.error,
        });
      } catch (err) {
        console.error(`[agent ${AGENT_ID}] compound fulfill threw:`, err);
        return c.json({ compound: true, status: 'failed', error: String(err) }, 500);
      }
    }

    // Simple capability flow (unchanged) — generate deliverable via the
    // same LLM the agent uses for strategy.
    const res = await generateText({
      model: languageModel,
      system: `You are ${AGENT_ID} fulfilling a "${cap}" hire on the Swarmwage tournament. Return ONLY the deliverable as JSON (no markdown wrapping).`,
      prompt: JSON.stringify(payload).slice(0, 8000),
      maxTokens: 800,
    });
    submitReceipt({
      account,
      registryUrl: REGISTRY_URL,
      payload: {
        protocol_version: 'swarmwage/v0.1',
        hire_id: crypto.randomUUID(),
        buyer: buyerAddress as `0x${string}`,
        capability: cap,
        amount_usdc_atomic: '0',
        network: 'base',
        tx_hash: '0x0',
        completed_at: new Date().toISOString(),
        verification: { all_passed: true, checks: { delivered: true } },
      },
    }).catch((e) => console.error('receipt submit failed:', e));
    return c.json({ result: res.text, model: modelSpec.label });
  });
  serve({ fetch: sellerApp.fetch, port: PORT });
  console.log(`[agent ${AGENT_ID}] seller surface :${PORT} (${modelSpec.label}, ${address})`);

  // Bootstrap compound listings AFTER the seller surface is listening so the
  // registry's endpoint-verify probe (when enabled) hits a live route.
  if (COMPOUND_AUTO_PUBLISH && PRIMARY_CAPABILITY) {
    publishCompoundListings({
      agentId: AGENT_ID,
      primaryCapability: PRIMARY_CAPABILITY as SimpleCapability,
      capabilityPrefix: CAPABILITY_PREFIX,
      ctx,
    }).catch((e) => console.error(`[agent ${AGENT_ID}] compound bootstrap failed:`, e));
  }

  // Strategist tick loop
  let cumulativeUsd = 0;
  let tickN = 0;
  const tournamentEndMs = new Date(TOURNAMENT_END).getTime();

  while (Date.now() < tournamentEndMs) {
    if (cumulativeUsd >= MAX_API_USD) {
      console.log(`[agent ${AGENT_ID}] API budget exhausted — going dormant`);
      break;
    }
    tickN += 1;
    const tickStart = Date.now();
    const remainingHours = ((tournamentEndMs - tickStart) / 3_600_000).toFixed(2);

    const userPrompt = `Tick #${tickN}. Time remaining: ${remainingHours} hours. Cumulative API spend so far: $${cumulativeUsd.toFixed(3)} / $${MAX_API_USD}. What's your move this tick?`;

    try {
      const result = await generateText({
        model: languageModel,
        system: systemPrompt,
        prompt: userPrompt,
        tools,
        maxSteps: 6,
        maxTokens: 1024,
      });

      const usd = estimateUsd(modelSpec, result.usage);
      cumulativeUsd += usd;

      appendFileSync(
        TICK_LOG,
        JSON.stringify({
          ts: new Date().toISOString(),
          tick: tickN,
          model: modelSpec.id,
          usage: result.usage,
          usd_estimated: usd,
          steps: result.steps.length,
          text: result.text.slice(0, 400),
        }) + '\n',
      );
    } catch (err) {
      appendFileSync(
        TICK_LOG,
        JSON.stringify({ ts: new Date().toISOString(), tick: tickN, error: String(err) }) + '\n',
      );
    }

    const elapsed = Date.now() - tickStart;
    const wait = Math.max(0, TICK_INTERVAL_MS - elapsed);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }

  console.log(`[agent ${AGENT_ID}] tournament ended, ticks=${tickN}, spend=$${cumulativeUsd.toFixed(3)}`);
})().catch((e) => {
  console.error(`[agent ${AGENT_ID}] fatal:`, e);
  process.exit(1);
});

/**
 * Publish a `compound.*` listing for every template that includes this
 * agent's `primaryCapability` in its components. Price = sum-of-mid-band-
 * component-cost × COMPOUND_MARGIN_MULT, clamped to the template's buyer
 * band so listings stay competitive.
 *
 * Best-effort: a single failure is logged but does not abort the rest.
 */
async function publishCompoundListings(args: {
  agentId: string;
  primaryCapability: SimpleCapability;
  capabilityPrefix: string;
  ctx: ToolContext;
}): Promise<void> {
  const eligible = COMPOUND_TEMPLATES.filter((t: CompoundTemplate) =>
    t.components.includes(args.primaryCapability),
  );
  if (eligible.length === 0) {
    console.log(`[agent ${args.agentId}] no compound templates include ${args.primaryCapability}`);
    return;
  }
  for (const template of eligible) {
    const lower = estimateComponentCost(template, COMPOUND_PER_COMPONENT_USDC);
    const target = lower * COMPOUND_MARGIN_MULT;
    const priceUsdc = clamp(target, template.buyer_min_usdc, template.buyer_max_usdc).toFixed(2);
    const endpoint = `${args.ctx.myEndpointBase}/capabilities/${encodeURIComponent(template.name)}`;
    try {
      await publishListing({
        account: args.ctx.account,
        registryUrl: args.ctx.registryUrl,
        capability: template.name,
        price_usdc: priceUsdc,
        endpoint,
        max_latency_ms: Math.min(COMPOUND_MAX_LATENCY_MS, template.delivery_window_s * 1000),
        first_call_free: false,
      });
      console.log(
        `[agent ${args.agentId}] published ${template.name} at ${priceUsdc} USDC (band ${template.buyer_min_usdc}-${template.buyer_max_usdc})`,
      );
    } catch (err) {
      console.error(`[agent ${args.agentId}] failed to publish ${template.name}:`, err);
    }
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

interface UsageLike {
  promptTokens: number;
  completionTokens: number;
}

function estimateUsd(spec: { provider: string }, usage: UsageLike | undefined): number {
  if (!usage) return 0;
  // Per-1M-token rates, verified 2026-05-22. Used only for the agent-side
  // soft budget gate; the orchestrator pulls real billing from each
  // provider for the hard kill decision.
  const rates: Record<string, { in: number; out: number }> = {
    anthropic: { in: 3.00 / 1_000_000, out: 15.00 / 1_000_000 }, // Sonnet 4.6 (Haiku is cheaper but we round up)
    openai:    { in: 0.625 / 1_000_000, out: 5.00 / 1_000_000 }, // GPT-5; GPT-5 Mini lower at $0.25/$2
    google:    { in: 1.25 / 1_000_000, out: 10.00 / 1_000_000 }, // Gemini 2.5 Pro
    mistral:   { in: 2.00 / 1_000_000, out: 6.00 / 1_000_000 },  // Mistral Large 2
    xai:       { in: 1.25 / 1_000_000, out: 2.50 / 1_000_000 },  // Grok 4.3
    deepseek:  { in: 0.55 / 1_000_000, out: 2.19 / 1_000_000 },  // DeepSeek R1
    moonshot:  { in: 0.60 / 1_000_000, out: 2.50 / 1_000_000 },  // Kimi K2-0905
    alibaba:   { in: 0.80 / 1_000_000, out: 2.40 / 1_000_000 },  // Qwen 2.5 72B
  };
  const r = rates[spec.provider] ?? rates.openai;
  return usage.promptTokens * r.in + usage.completionTokens * r.out;
}
