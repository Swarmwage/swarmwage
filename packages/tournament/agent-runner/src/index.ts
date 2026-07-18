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

import './proxy-bootstrap.js';
import { serve } from '@hono/node-server';
import { Hono, type Context } from 'hono';
import { paymentMiddleware, type Network } from 'x402-hono';
import { SWARMWAGE_FACILITATOR_URL } from '@swarmwage/agent-sdk';
import { generateText } from 'ai';
import { existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { createRemoteAccount } from './remote-account.js';
import { pickModel, resolveLanguageModel } from './llm.js';
import { buildTools, type ToolContext } from './tools.js';
import { buildSystemPrompt } from './system-prompt.js';
import { publishListing, submitReceipt, searchAgents } from './sdk-bridge.js';
import { getListedPrice, recordListedPrice } from './price-registry.js';
import { fulfillCompound } from './compound.js';
import { emitTick } from './emit-tick.js';
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
// Seller-side x402 paywall: the facilitator that verifies the buyer's
// X-PAYMENT and settles the EIP-3009 transfer on-chain (gas-relay only).
// Defaults to the Swarmwage facilitator — the same one buyers point to.
const FACILITATOR_URL = process.env.FACILITATOR_URL ?? SWARMWAGE_FACILITATOR_URL;
const PAYMENT_NETWORK = (process.env.PAYMENT_NETWORK ?? 'base') as Network;

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

// Per-model generation knobs.
//  - Reasoning models (GPT-5, DeepSeek R1) burn output tokens on hidden
//    reasoning *before* emitting a tool call; the old 1024 cap starved them
//    (GPT-5 hit finishReason:'length' and never reached hire_agent). Headroom.
//  - Moonshot rejects any temperature != 1, so pin it for that provider.
const IS_REASONING_MODEL = modelSpec.provider === 'openai' || modelSpec.provider === 'deepseek';
const TICK_MAX_TOKENS = IS_REASONING_MODEL ? 4096 : 1024;
const PROVIDER_GEN_OPTS: { temperature?: number } =
  modelSpec.provider === 'moonshot' ? { temperature: 1 } : {};

(async () => {
  // Resolve our public address from the wallet sidecar
  const walletSvcToken = process.env.WALLET_SVC_TOKEN;
  const addrRes = await fetch(
    `${WALLET_SVC_URL}/wallets/${AGENT_ID}/address`,
    walletSvcToken ? { headers: { authorization: `Bearer ${walletSvcToken}` } } : undefined,
  );
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
  const sellerApp = new Hono();
  sellerApp.get('/health', (c) => c.json({ ok: true, agent_id: AGENT_ID, address }));

  // Seller-side x402 paywall. Resolves the authoritative price THIS agent
  // advertised for the requested capability, returns a 402 challenge, then lets
  // x402-hono verify the buyer's X-PAYMENT header and settle the EIP-3009
  // transfer on-chain via the facilitator BEFORE the deliverable handler runs.
  // Without this gate the route returned 200 with no payment and no USDC ever
  // moved — the buyer's wrapFetchWithPayment only pays when it receives a 402.
  const x402PaywallGate = async (c: Context, next: () => Promise<void>) => {
    const cap = c.req.param('name');
    const price = cap ? await resolveListedPrice(cap) : undefined;
    if (!price) {
      // We never advertised this capability → refuse rather than work for free.
      return c.json({ error: `capability not offered by this agent: ${cap}` }, 404);
    }
    // Price is chosen at runtime and differs per capability, so we build the
    // middleware per-request with the resolved price. The route key MUST be a
    // catch-all glob: x402's `computeRoutePatterns` turns a bare `{price,…}`
    // object into literal `price`/`network` route keys (which never match the
    // path), and an exact `POST /capabilities/<dotted-cap>/hire` key proved
    // fragile behind the leaderboard proxy. `POST /*` → `^\/.*?$` matches any
    // path; since this middleware is only ever invoked on the hire route, the
    // catch-all is safe and always enforces the 402.
    const mw = paymentMiddleware(
      address,
      { 'POST /*': { price: `$${price}`, network: PAYMENT_NETWORK } },
      { url: FACILITATOR_URL as `${string}://${string}` },
    );
    return mw(c, next);
  };

  // Resolve the authoritative price for `cap`. Prefers the in-process map
  // (populated on publish), but falls back to the registry listing this agent
  // published — the in-process map is empty after a restart while listings
  // persist in the registry DB, so without this fallback the gate would 404
  // legitimate hires until the agent happens to re-publish.
  async function resolveListedPrice(cap: string): Promise<string | undefined> {
    const listed = getListedPrice(cap);
    if (listed) return listed.price_usdc;
    try {
      const entries = await searchAgents({ registryUrl: REGISTRY_URL, capability: cap, limit: 50 });
      const mine = entries.find((e) => e.agent_id.toLowerCase() === address.toLowerCase());
      if (mine?.listing?.price_usdc) {
        recordListedPrice(cap, mine.listing.price_usdc, mine.listing.first_call_free ?? false);
        return mine.listing.price_usdc;
      }
    } catch (err) {
      console.error(`[agent ${AGENT_ID}] price fallback lookup failed for ${cap}:`, err);
    }
    return undefined;
  }

  // Receipt post-hook. Mounted BEFORE the paywall gate so its post-`next()`
  // phase runs AFTER x402-hono has settled and attached the X-PAYMENT-RESPONSE
  // header (in x402-hono v1.2 settlement happens after next()). Only then is
  // the real on-chain tx hash known. Submitting a placeholder '0x0' (as the
  // old inline calls did) is rejected by the registry's tx_hash regex, so no
  // reputation ever registered.
  const submitReceiptPostHook = async (c: Context, next: () => Promise<void>) => {
    await next();
    if (c.res.status !== 200) return; // only attest successful deliveries
    const header = c.res.headers.get('X-PAYMENT-RESPONSE');
    if (!header) return; // no settlement (e.g. first-call-free) → nothing to attest
    let tx_hash = '';
    let payer = '';
    try {
      const s = JSON.parse(Buffer.from(header, 'base64').toString('utf8')) as {
        transaction?: string;
        payer?: string;
      };
      tx_hash = s.transaction ?? '';
      payer = (s.payer ?? '').toLowerCase();
    } catch {
      return;
    }
    if (!/^0x[0-9a-fA-F]{64}$/.test(tx_hash)) return; // registry needs a real hash
    const cap = c.req.param('name');
    if (!cap) return;
    let buyer = payer;
    try {
      const body = (await c.req.json()) as { buyer_id?: string };
      if (body?.buyer_id) buyer = String(body.buyer_id).toLowerCase();
    } catch {
      /* body already consumed — fall back to the payer from the settlement */
    }
    const price = getListedPrice(cap)?.price_usdc ?? '0';
    const amount_usdc_atomic = String(Math.round(parseFloat(price) * 1e6) || 0);
    submitReceipt({
      account,
      registryUrl: REGISTRY_URL,
      payload: {
        protocol_version: 'swarmwage/v0.1',
        hire_id: crypto.randomUUID(),
        buyer: (buyer || '0x0') as `0x${string}`,
        capability: cap,
        amount_usdc_atomic,
        network: 'base',
        tx_hash: tx_hash as `0x${string}`,
        completed_at: new Date().toISOString(),
        verification: { all_passed: true, checks: { delivered: true, settled: true } },
      },
    }).catch((e) => console.error('receipt submit failed:', e));
  };

  // Route MUST end in `/hire` to match the SDK convention used by every
  // buyer (sdk-bridge + tournament-buyer-agent both POST `${endpoint}/hire`).
  // The published listing endpoint is `${MY_ENDPOINT_BASE}/capabilities/<name>`;
  // the buyer appends `/hire` to it.
  sellerApp.post('/capabilities/:name/hire', submitReceiptPostHook, x402PaywallGate, async (c) => {
    // Guaranteed present: the route binds `:name` and x402PaywallGate already
    // 404s when the capability isn't listed (which requires a defined name).
    const cap = c.req.param('name')!;
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
        // Receipt is submitted by submitReceiptPostHook once settlement is
        // confirmed (it carries the real on-chain tx hash + amount).
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
      maxTokens: IS_REASONING_MODEL ? 2048 : 800,
      ...PROVIDER_GEN_OPTS,
    });
    // Receipt is submitted by submitReceiptPostHook once settlement is
    // confirmed (it carries the real on-chain tx hash + amount).
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
        maxTokens: TICK_MAX_TOKENS,
        ...PROVIDER_GEN_OPTS,
      });

      const usd = estimateUsd(modelSpec, result.usage);
      cumulativeUsd += usd;

      // Derive a high-level action label from the tool calls this tick made.
      const toolNames = (result.steps ?? [])
        .flatMap((s) => (s.toolCalls ?? []).map((tc) => tc.toolName))
        .filter(Boolean);
      const action = pickAction(toolNames);

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

      // Fire-and-forget telemetry to the public dashboard (no-op unless
      // COLLECTOR_URL is set; safe, 2s-bounded, internal-network only).
      emitTick({
        agent_id: AGENT_ID,
        tick: tickN,
        action,
        rationale: result.text.slice(0, 600),
        detail: { tools: toolNames.slice(0, 6), api_usd_cum: Number(cumulativeUsd.toFixed(3)) },
      });
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
      // Make the price enforceable by the seller paywall.
      recordListedPrice(template.name, priceUsdc, false);
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

/**
 * Collapse the tool calls made in a tick into one headline verb for the
 * public dashboard. Priority order reflects what's most interesting to watch:
 * a hire/publish beats a passive search/leaderboard read.
 */
function pickAction(toolNames: string[]): string {
  const has = (n: string) => toolNames.includes(n);
  if (has('hire_agent')) return 'hire';
  if (has('publish_listing')) return 'publish';
  if (has('inspect_compound_market')) return 'inspect-market';
  if (has('search_agents')) return 'search';
  if (has('check_reputation')) return 'check-reputation';
  if (has('leaderboard') || has('recent_market_activity')) return 'observe';
  if (has('note_to_self') || has('read_my_notes')) return 'plan';
  if (has('check_my_balance') || has('list_my_listings')) return 'review';
  return toolNames.length ? toolNames[0] : 'think';
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
