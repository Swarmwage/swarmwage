// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Swarmwage
//
// Shared compound-capability schema for the tournament.
//
// Compound capabilities are multi-component services that a single agent
// cannot fulfill alone. The broker that accepts a compound hire MUST
// sub-hire one specialist per entry in `components`, aggregate the
// returned artifacts, and deliver the bundle to the buyer.
//
// This file is the canonical contract referenced by:
//   - packages/tournament/buyer-agent/   (publishes compound orders)
//   - packages/tournament/agent-runner/  (fulfills compound orders via sub-hire)
//   - packages/tournament/orchestrator/  (surfaces compound vs simple metrics)
//
// Keep ids stable once published. Adding a new template is safe; renaming
// or removing one breaks live receipts.

export type SimpleCapability =
  | 'text.long-form'
  | 'text.editorial-review'
  | 'image.generate'
  | 'chart.from-data'
  | 'audio.tts';

export interface CompoundTemplate {
  /** Registry capability id (e.g., "compound.research-brief"). */
  name: string;
  /** Display label for leaderboard + UI. */
  label: string;
  /** Components the broker MUST sub-hire. Duplicates allowed (e.g., 2 charts). */
  components: SimpleCapability[];
  /** Buyer's willingness-to-pay range, USDC. Broker may price within this band. */
  buyer_min_usdc: number;
  buyer_max_usdc: number;
  /** Total time budget for delivery, seconds. After this, buyer disputes. */
  delivery_window_s: number;
  /** Brief template; the buyer substitutes {{TOPIC}} at order time. */
  brief_template: string;
  /** Required keys in the returned JSON payload. */
  output_schema: readonly string[];
}

export const COMPOUND_TEMPLATES: readonly CompoundTemplate[] = [
  {
    name: 'compound.research-brief',
    label: 'Research Brief',
    components: ['text.long-form', 'chart.from-data', 'image.generate'],
    buyer_min_usdc: 0.30,
    buyer_max_usdc: 0.50,
    delivery_window_s: 300,
    brief_template:
      'Produce a research brief on topic: {{TOPIC}}. ' +
      'Deliverables: 1 article (800-1200 words), 1 supporting data chart, ' +
      '1 cover image. Return JSON with keys: article, chart_url, image_url.',
    output_schema: ['article', 'chart_url', 'image_url'],
  },
  {
    name: 'compound.media-pack',
    label: 'Media Pack',
    components: ['image.generate', 'chart.from-data', 'audio.tts'],
    buyer_min_usdc: 0.25,
    buyer_max_usdc: 0.45,
    delivery_window_s: 300,
    brief_template:
      'Produce a media pack on topic: {{TOPIC}}. ' +
      'Deliverables: 1 hero image, 1 data chart, 1 short audio summary ' +
      '(60-90 seconds, plain spoken). Return JSON with keys: image_url, ' +
      'chart_url, audio_url, audio_transcript.',
    output_schema: ['image_url', 'chart_url', 'audio_url', 'audio_transcript'],
  },
  {
    name: 'compound.dossier',
    label: 'Dossier',
    components: [
      'text.long-form',
      'chart.from-data',
      'chart.from-data',
      'text.editorial-review',
    ],
    buyer_min_usdc: 0.45,
    buyer_max_usdc: 0.70,
    delivery_window_s: 400,
    brief_template:
      'Produce a dossier on topic: {{TOPIC}}. ' +
      'Deliverables: 1 article (1200-1500 words), 2 data charts (different ' +
      'angles), 1 editorial review pass on the article. Return JSON with ' +
      'keys: article, charts (array of 2 urls), editorial_notes.',
    output_schema: ['article', 'charts', 'editorial_notes'],
  },
  {
    name: 'compound.podcast-package',
    label: 'Podcast Package',
    components: ['audio.tts', 'text.long-form', 'image.generate'],
    buyer_min_usdc: 0.30,
    buyer_max_usdc: 0.55,
    delivery_window_s: 300,
    brief_template:
      'Produce a podcast package on topic: {{TOPIC}}. ' +
      'Deliverables: 1 spoken audio episode (120 seconds), 1 episode ' +
      'transcript, 1 cover art. Return JSON with keys: audio_url, ' +
      'transcript, cover_url.',
    output_schema: ['audio_url', 'transcript', 'cover_url'],
  },
  {
    name: 'compound.infographic',
    label: 'Infographic',
    components: ['image.generate', 'chart.from-data', 'text.long-form'],
    buyer_min_usdc: 0.20,
    buyer_max_usdc: 0.35,
    delivery_window_s: 200,
    brief_template:
      'Produce an infographic kit on topic: {{TOPIC}}. ' +
      'Deliverables: 1 visual hero, 1 data chart, 1 short caption ' +
      '(150-250 words). Return JSON with keys: image_url, chart_url, caption.',
    output_schema: ['image_url', 'chart_url', 'caption'],
  },
] as const;

/** Topic pool the buyer-agent picks from for each order. */
export const TOPIC_POOL: readonly string[] = [
  'AI agent economics in 2030',
  'Stablecoin regulation in the EU vs US',
  'Climate-tech breakthroughs 2026',
  'Robotics labor market disruption',
  'Open-source MCP server ecosystem',
  'L2 rollup performance comparison',
  'Vector databases for production RAG',
  'Edge LLM deployment patterns',
  'Tokenization of real-world assets',
  'AI safety policy in 2026',
  'Privacy-preserving federated learning',
  'Decentralized identity standards',
] as const;

export function templateByName(name: string): CompoundTemplate | undefined {
  return COMPOUND_TEMPLATES.find((t) => t.name === name);
}

export function pickRandomTemplate(rng: () => number = Math.random): CompoundTemplate {
  return COMPOUND_TEMPLATES[Math.floor(rng() * COMPOUND_TEMPLATES.length)];
}

export function pickRandomTopic(rng: () => number = Math.random): string {
  return TOPIC_POOL[Math.floor(rng() * TOPIC_POOL.length)];
}

/** Sum of mid-band component prices, used as a sanity lower-bound on margin. */
export function estimateComponentCost(template: CompoundTemplate, perComponentUsdc: number): number {
  return template.components.length * perComponentUsdc;
}
