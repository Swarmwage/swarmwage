// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Swarmwage
//
// LLM-driven decision loop. Each tick, Claude Haiku 4.5 sees the buyer's
// current state and chooses ONE of:
//   - hire a compound template against a topic (with a price cap)
//   - wait (no-op this tick)
//
// The buyer's job in the tournament is to inject demand. The LLM mostly
// decides WHICH compound + WHICH topic to demand. Seller selection is
// deterministic (cheapest with adequate reputation) — see publish.ts.

import { createAnthropic } from '@ai-sdk/anthropic';
import { generateObject } from 'ai';
import { z } from 'zod';
import {
  COMPOUND_TEMPLATES,
  TOPIC_POOL,
  templateByName,
} from '@swarmwage/tournament-shared';
import type { DecisionAction, DecisionInput } from './types.js';

const MODEL_ID = 'claude-haiku-4-5';

// Haiku 4.5 token rates (2026-05, USD per million tokens).
const HAIKU_IN_PER_TOKEN = 1.0 / 1_000_000;
const HAIKU_OUT_PER_TOKEN = 5.0 / 1_000_000;

const ActionUnion = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('hire'),
    template: z.string().describe('Compound template name, e.g. compound.research-brief'),
    topic: z.string().describe('Topic for the {{TOPIC}} slot — pick from the provided topic pool'),
    max_price_usdc: z
      .string()
      .describe(
        'Max USDC to pay for this compound order (decimal string, e.g. "0.40"). MUST fall within the template buyer_min..buyer_max band.',
      ),
    rationale: z.string().describe('1-2 sentences explaining the choice.'),
  }),
  z.object({
    type: z.literal('wait'),
    rationale: z.string().describe('1 sentence explaining why no order this tick.'),
  }),
]);

// Anthropic's tool input_schema MUST be a top-level object ("type":"object").
// A bare discriminated union serialises to {anyOf:[...]} with no top-level
// "type", which the API rejects: "tools.0.custom.input_schema.type: Field
// required". Wrapping the union in an object makes generateObject emit a valid
// object schema; we read back result.object.action.
const ResponseSchema = z.object({
  action: ActionUnion.describe('The single action to take this tick.'),
});

export interface DecideResult {
  action: DecisionAction;
  usdSpent: number;
  raw: string;
}

export function buildSystemPrompt(buyerId: string): string {
  const templateLines = COMPOUND_TEMPLATES.map(
    (t) =>
      `- ${t.name} (${t.label}): components=${t.components.join(',')} band=$${t.buyer_min_usdc}-${t.buyer_max_usdc} window=${t.delivery_window_s}s`,
  ).join('\n');
  return `You are ${buyerId}, an external buyer-agent in the Swarmwage Agent Tournament.

You hold real USDC on Base mainnet and your only job is to BUY compound deliverables from the 10 internal tournament agents over the next 24 hours.

You are running on Claude Haiku 4.5. Your decisions inject demand into a closed agent economy.

## How the market works

- 10 internal agents compete for the highest USDC balance at T+24h.
- Each compound order you publish forces the chosen broker to sub-hire 3-4 specialist agents, generating cross-trade.
- You started with $10 USDC. Spend it across the full 24 hours — pacing matters. A reasonable budget: ~$0.40 per order × ~25 orders.
- The protocol settles on signed receipt, NOT on content quality. You do not judge output. You only choose what to demand and at what price ceiling.

## Compound templates (the only capabilities you may demand)

${templateLines}

## Pricing rule (HARD)

For every hire, max_price_usdc MUST be within the template's [buyer_min_usdc, buyer_max_usdc] band. Going lower starves brokers; going higher wastes your budget.

## When to WAIT instead of hire

- Your balance is below $0.50 (too little headroom for any order)
- You have already issued an order in the previous tick AND the market has zero new sellers (re-spamming the same broker doesn't generate cross-trade)
- Less than 1 hour remains AND your last 3 hires all failed

Otherwise: prefer HIRE. Idle ticks waste the demand-injection role.

Respond ONLY with the structured action.`;
}

function buildUserPrompt(d: DecisionInput): string {
  const hireSummary = d.recentHires
    .slice(-10)
    .map(
      (h) =>
        `  - ${h.ts} ${h.template} topic="${h.topic.slice(0, 40)}" ${h.ok ? `OK seller=${h.seller_id ?? '?'} price=${h.price_usdc ?? '?'}` : `FAIL ${h.error?.slice(0, 80) ?? ''}`}`,
    )
    .join('\n');
  const marketLines = COMPOUND_TEMPLATES.map(
    (t) =>
      `  - ${t.name}: ${d.marketSummary.template_listings[t.name] ?? 0} sellers, min=$${d.marketSummary.template_min_price_usdc[t.name] ?? 'n/a'}`,
  ).join('\n');
  const topicLines = TOPIC_POOL.map((t) => `  - ${t}`).join('\n');
  return `## State

- buyer_id: ${d.buyerId}
- balance_usdc: ${d.balanceUsdc.toFixed(4)}
- hours_elapsed: ${d.hoursElapsed.toFixed(2)}
- hours_remaining: ${d.hoursRemaining.toFixed(2)}

## Recent hires (last 10, oldest first)
${hireSummary || '  (none yet)'}

## Current market (live registry snapshot)
${marketLines}

## Topic pool (pick exactly one)
${topicLines}

What's your move this tick? Pick a template + topic + price within the band, or wait.`;
}

export async function decide(args: {
  apiKey: string;
  buyerId: string;
  input: DecisionInput;
}): Promise<DecideResult> {
  const anthropic = createAnthropic({ apiKey: args.apiKey });
  const model = anthropic(MODEL_ID);

  const system = buildSystemPrompt(args.buyerId);
  const prompt = buildUserPrompt(args.input);

  const result = await generateObject({
    model,
    schema: ResponseSchema,
    system,
    prompt,
    maxTokens: 400,
  });

  const usage = result.usage as { promptTokens?: number; completionTokens?: number } | undefined;
  const usd =
    (usage?.promptTokens ?? 0) * HAIKU_IN_PER_TOKEN +
    (usage?.completionTokens ?? 0) * HAIKU_OUT_PER_TOKEN;

  let action: DecisionAction = result.object.action;
  action = validateAndClamp(action);
  return { action, usdSpent: usd, raw: JSON.stringify(result.object.action) };
}

/**
 * Final sanity check on the LLM's output: confirm the template exists and
 * the price falls within the band. If the LLM picks an unknown template,
 * downgrade to wait. If the price is outside the band, clamp to the
 * mid-point of the band rather than silently violating the contract.
 */
function validateAndClamp(action: DecisionAction): DecisionAction {
  if (action.type === 'wait') return action;
  const tpl = templateByName(action.template);
  if (!tpl) {
    return {
      type: 'wait',
      rationale: `unknown template "${action.template}" — skipping`,
    };
  }
  const price = parseFloat(action.max_price_usdc);
  if (!Number.isFinite(price) || price <= 0) {
    return {
      type: 'hire',
      template: action.template,
      topic: action.topic,
      max_price_usdc: ((tpl.buyer_min_usdc + tpl.buyer_max_usdc) / 2).toFixed(2),
      rationale: action.rationale,
    };
  }
  if (price < tpl.buyer_min_usdc) {
    return {
      ...action,
      max_price_usdc: tpl.buyer_min_usdc.toFixed(2),
    };
  }
  if (price > tpl.buyer_max_usdc) {
    return {
      ...action,
      max_price_usdc: tpl.buyer_max_usdc.toFixed(2),
    };
  }
  return action;
}
