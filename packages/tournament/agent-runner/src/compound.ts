// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Swarmwage
//
// Compound-hire fulfillment.
//
// When an internal agent's seller endpoint receives a hire for a `compound.*`
// capability, this module decomposes the order, sub-hires one specialist per
// component from the registry via the SDK bridge, aggregates the returned
// artifacts, and produces a payload matching `template.output_schema`.
//
// Design rules (locked 2026-05-24):
//   - The broker MUST never spend more than `payment_usdc - BROKER_RESERVE_USDC`
//     across all sub-hires combined (hard cap; enforced before each sub-hire).
//   - Missing seller for any one component → status='failed', NO partial
//     output, NO receipt submission upstream. Buyer disputes.
//   - Sub-hire timeout / error → retry once with the next-best seller for that
//     component; if both attempts fail, mark that component failed.
//   - Partial failures (some components delivered, others not) → status='partial',
//     return whatever was collected. Broker keeps leftover USDC as cost-recovery.
//   - All sub-hires go through the wallet-svc-backed remote account
//     (broker process holds no raw private key).

import type { SearchResultEntry } from '@swarmwage/agent-sdk';
import type { CompoundTemplate, SimpleCapability } from '@swarmwage/tournament-shared';
import { hireAgent, searchAgents } from './sdk-bridge.js';
import type { ToolContext } from './tools.js';

/** Atomic-USDC reserve the broker must keep from the buyer's payment. */
export const BROKER_RESERVE_USDC = 0.05;

/** Per sub-hire latency cap (ms). After this we treat the sub-hire as failed. */
const SUB_HIRE_TIMEOUT_MS = 60_000;

/** Maximum candidates pulled from the registry per component. */
const SEARCH_LIMIT = 10;

/** Min reputation threshold to prefer a seller; falls back to lowest-price if no candidate clears this. */
const MIN_SUCCESS_RATE = 0.5;

export interface SubHireRecord {
  /** The simple capability the broker sub-hired for. */
  component: SimpleCapability;
  /** Lowercase 0x address of the seller (broker's pick). */
  seller_agent_id: string;
  /** Decimal-string USDC the broker offered as `max_price_usdc`. */
  max_price_usdc: string;
  /** Decimal-string USDC the broker actually spent (best-effort: equals max_price if hire succeeded). */
  spent_usdc: string;
  /** Whether the sub-hire delivered something usable. */
  ok: boolean;
  /** Elapsed wall time, ms. */
  latency_ms: number;
  /** Short error string when ok=false. */
  error?: string;
  /** The raw deliverable returned by the sub-hire (truncated by the broker if huge). */
  result?: unknown;
}

export interface FulfillCompoundResult {
  status: 'ok' | 'partial' | 'failed';
  output: Record<string, unknown>;
  sub_hires: SubHireRecord[];
  total_spent_usdc: number;
  error?: string;
}

export interface FulfillCompoundArgs {
  template: CompoundTemplate;
  topic: string;
  /** Decimal USDC the buyer is paying the broker, in human-readable form. */
  payment_usdc: number;
  ctx: ToolContext;
  /** Buyer's lowercase 0x address, propagated into sub-hire payloads for context. */
  buyerAddress: string;
}

/**
 * Decompose a compound hire into sub-hires, aggregate, and return the bundled
 * deliverable. Pure orchestration — no LLM calls, no signing, no on-chain
 * touch beyond what the SDK's hireAgent already does.
 */
export async function fulfillCompound(args: FulfillCompoundArgs): Promise<FulfillCompoundResult> {
  const { template, topic, payment_usdc, ctx, buyerAddress } = args;

  const budgetUsdc = payment_usdc - BROKER_RESERVE_USDC;
  if (budgetUsdc <= 0) {
    return {
      status: 'failed',
      output: {},
      sub_hires: [],
      total_spent_usdc: 0,
      error: `payment ${payment_usdc} USDC ≤ broker reserve ${BROKER_RESERVE_USDC}`,
    };
  }

  // Pre-resolve seller candidates for each component. Done once upfront
  // (instead of per-component sequentially) so the broker has a global view
  // and can fail fast if any component has zero candidates.
  const componentPlans = await Promise.all(
    template.components.map(async (component) => {
      const candidates = await safeSearchAgents(ctx, component);
      const ranked = rankCandidates(candidates);
      return { component, candidates: ranked };
    }),
  );

  const missing = componentPlans.filter((p) => p.candidates.length === 0);
  if (missing.length > 0) {
    return {
      status: 'failed',
      output: {},
      sub_hires: [],
      total_spent_usdc: 0,
      error: `no seller for ${missing.map((m) => m.component).join(', ')}`,
    };
  }

  // Sequential sub-hires so we can enforce the running budget cap and abort
  // before overspending. Parallel would be faster but harder to bound.
  const subHires: SubHireRecord[] = [];
  let spentUsdc = 0;

  for (const plan of componentPlans) {
    const remaining = budgetUsdc - spentUsdc;
    if (remaining <= 0) {
      subHires.push({
        component: plan.component,
        seller_agent_id: '0x0',
        max_price_usdc: '0',
        spent_usdc: '0',
        ok: false,
        latency_ms: 0,
        error: 'broker budget exhausted before this component',
      });
      continue;
    }

    const hire = await trySubHire({
      ctx,
      component: plan.component,
      candidates: plan.candidates,
      remainingUsdc: remaining,
      template,
      topic,
      buyerAddress,
    });
    subHires.push(hire);
    if (hire.ok) {
      spentUsdc += parseFloat(hire.spent_usdc);
    }
  }

  const successfulByComponent = new Map<SimpleCapability, SubHireRecord[]>();
  for (const sh of subHires.filter((s) => s.ok)) {
    const list = successfulByComponent.get(sh.component) ?? [];
    list.push(sh);
    successfulByComponent.set(sh.component, list);
  }

  const output = aggregateOutput(template, successfulByComponent);
  const okCount = subHires.filter((s) => s.ok).length;
  const status: 'ok' | 'partial' | 'failed' =
    okCount === subHires.length ? 'ok' : okCount === 0 ? 'failed' : 'partial';

  return {
    status,
    output,
    sub_hires: subHires,
    total_spent_usdc: spentUsdc,
    error:
      status === 'failed'
        ? 'all sub-hires failed'
        : status === 'partial'
          ? `${subHires.length - okCount} of ${subHires.length} sub-hires failed`
          : undefined,
  };
}

async function safeSearchAgents(
  ctx: ToolContext,
  capability: string,
): Promise<SearchResultEntry[]> {
  try {
    // Component capabilities are published under the tournament prefix
    // (e.g. `tournament.2026-05-26.text.long-form`), so search for the
    // prefixed name unless the caller already passed a prefixed/compound id.
    const q =
      capability.startsWith(ctx.capabilityPrefix) || capability.startsWith('compound.')
        ? capability
        : `${ctx.capabilityPrefix}${capability}`;
    const results = await searchAgents({
      registryUrl: ctx.registryUrl,
      capability: q,
      limit: SEARCH_LIMIT,
    });
    return results.filter((r) => r.agent_id.toLowerCase() !== ctx.agentAddress);
  } catch {
    return [];
  }
}

/**
 * Rank candidates by (a) reputation tier (success_rate ≥ threshold preferred),
 * then (b) lowest price. Within the preferred tier, ties go to lowest latency.
 */
function rankCandidates(candidates: SearchResultEntry[]): SearchResultEntry[] {
  const priced = candidates
    .map((c) => ({ c, price: parseFloat(c.listing.price_usdc) }))
    .filter((x) => Number.isFinite(x.price));

  return priced
    .sort((a, b) => {
      const aTrusted = a.c.reputation.success_rate >= MIN_SUCCESS_RATE ? 1 : 0;
      const bTrusted = b.c.reputation.success_rate >= MIN_SUCCESS_RATE ? 1 : 0;
      if (aTrusted !== bTrusted) return bTrusted - aTrusted;
      if (a.price !== b.price) return a.price - b.price;
      return a.c.reputation.avg_latency_ms - b.c.reputation.avg_latency_ms;
    })
    .map((x) => x.c);
}

interface TrySubHireArgs {
  ctx: ToolContext;
  component: SimpleCapability;
  candidates: SearchResultEntry[];
  remainingUsdc: number;
  template: CompoundTemplate;
  topic: string;
  buyerAddress: string;
}

/**
 * Hire the top candidate for a component. On timeout or hire error, retry
 * once with the second-best candidate. Returns a record either way.
 */
async function trySubHire(args: TrySubHireArgs): Promise<SubHireRecord> {
  const affordable = args.candidates.filter(
    (c) => parseFloat(c.listing.price_usdc) <= args.remainingUsdc,
  );
  if (affordable.length === 0) {
    return {
      component: args.component,
      seller_agent_id: '0x0',
      max_price_usdc: '0',
      spent_usdc: '0',
      ok: false,
      latency_ms: 0,
      error: `no candidate within remaining budget ${args.remainingUsdc.toFixed(4)} USDC`,
    };
  }

  const primary = affordable[0];
  const secondary = affordable[1];
  const componentBrief = buildComponentBrief(args.template, args.component, args.topic);

  const primaryAttempt = await attemptHire({
    ctx: args.ctx,
    candidate: primary,
    component: args.component,
    brief: componentBrief,
    buyerAddress: args.buyerAddress,
  });
  if (primaryAttempt.ok) return primaryAttempt;

  if (!secondary) {
    return { ...primaryAttempt, error: `${primaryAttempt.error} (no fallback candidate)` };
  }

  const secondaryAttempt = await attemptHire({
    ctx: args.ctx,
    candidate: secondary,
    component: args.component,
    brief: componentBrief,
    buyerAddress: args.buyerAddress,
  });
  if (secondaryAttempt.ok) return secondaryAttempt;

  return {
    ...secondaryAttempt,
    error: `primary failed (${primaryAttempt.error}); fallback failed (${secondaryAttempt.error})`,
  };
}

interface AttemptHireArgs {
  ctx: ToolContext;
  candidate: SearchResultEntry;
  component: SimpleCapability;
  brief: { instruction: string; topic: string };
  buyerAddress: string;
}

async function attemptHire(args: AttemptHireArgs): Promise<SubHireRecord> {
  const { ctx, candidate, component, brief, buyerAddress } = args;
  const sellerId = candidate.agent_id.toLowerCase();
  // Pay exactly the listed price (no haggling); SDK enforces max_price_usdc
  // as the upper bound for the x402 challenge.
  const price = candidate.listing.price_usdc;
  const t0 = Date.now();
  try {
    const result = await withTimeout(
      hireAgent({
        account: ctx.account,
        registryUrl: ctx.registryUrl,
        rpcUrl: ctx.rpcUrl,
        capability: candidate.listing.capability,
        params: {
          instruction: brief.instruction,
          topic: brief.topic,
          component,
          via_broker: ctx.agentAddress,
          original_buyer: buyerAddress,
        },
        max_price_usdc: price,
        seller_agent_id: sellerId,
        endpoint: candidate.listing.endpoint,
      }),
      SUB_HIRE_TIMEOUT_MS,
    );
    return {
      component,
      seller_agent_id: sellerId,
      max_price_usdc: price,
      spent_usdc: price,
      ok: true,
      latency_ms: Date.now() - t0,
      result,
    };
  } catch (err) {
    return {
      component,
      seller_agent_id: sellerId,
      max_price_usdc: price,
      spent_usdc: '0',
      ok: false,
      latency_ms: Date.now() - t0,
      error: shortError(err),
    };
  }
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

function shortError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.slice(0, 200);
}

/**
 * Per-component brief — keeps the buyer's topic intact and tells the seller
 * exactly which slice of the compound order it is being asked to produce.
 */
function buildComponentBrief(
  template: CompoundTemplate,
  component: SimpleCapability,
  topic: string,
): { instruction: string; topic: string } {
  const componentTask: Record<SimpleCapability, string> = {
    'text.long-form':
      'Write the long-form article for this compound order. Plain prose, 600-1200 words. Topic-focused.',
    'text.editorial-review':
      'Editorial review pass: return ~5 bullet improvement notes for the article on this topic.',
    'image.generate':
      'Generate one cover/illustration image relevant to the topic. Return a URL or data reference.',
    'chart.from-data':
      'Produce one supporting data chart on the topic. Return a URL or chart specification.',
    'audio.tts':
      'Produce one short spoken-audio summary on the topic (~60-120s). Return a URL plus transcript.',
  };
  return {
    instruction: `Compound order context: ${template.label}. ` + componentTask[component],
    topic,
  };
}

/**
 * Collapse the sub-hire payloads into the shape declared by template.output_schema.
 * If a key cannot be satisfied (because that component failed), it is set to
 * null so the caller can see which slot is missing rather than the whole
 * payload being absent.
 *
 * Mapping is conservative: each output key is matched to one component family;
 * the broker picks the first successful sub-hire of that family. For compound
 * templates with duplicate components (e.g. dossier's 2× chart), the schema
 * uses an array key (e.g. "charts") and we collect ALL successful sub-hires
 * of that component.
 */
function aggregateOutput(
  template: CompoundTemplate,
  successfulByComponent: Map<SimpleCapability, SubHireRecord[]>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  for (const key of template.output_schema) {
    const lower = key.toLowerCase();
    if (lower === 'charts') {
      const charts = (successfulByComponent.get('chart.from-data') ?? []).map((sh) => sh.result);
      out[key] = charts;
      continue;
    }

    const family = inferComponentFromKey(lower);
    if (!family) {
      out[key] = null;
      continue;
    }
    const records = successfulByComponent.get(family) ?? [];
    const pick = records[0]?.result ?? null;

    // Slim heuristic: if the seller returned a plain string, store it under
    // this key directly. If it returned an object, try to pull the matching
    // sub-key, falling back to the whole object.
    if (pick == null) {
      out[key] = null;
    } else if (typeof pick === 'string' || typeof pick === 'number' || typeof pick === 'boolean') {
      out[key] = pick;
    } else if (typeof pick === 'object') {
      const obj = pick as Record<string, unknown>;
      out[key] = obj[key] ?? obj.result ?? obj.output ?? obj;
    } else {
      out[key] = pick;
    }
  }

  return out;
}

function inferComponentFromKey(key: string): SimpleCapability | null {
  if (key.includes('article') || key.includes('caption') || key.includes('transcript'))
    return 'text.long-form';
  if (key.includes('editorial')) return 'text.editorial-review';
  if (key.includes('image') || key.includes('cover')) return 'image.generate';
  if (key.includes('chart')) return 'chart.from-data';
  if (key.includes('audio')) return 'audio.tts';
  return null;
}
