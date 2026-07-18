// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Swarmwage
//
// Canonical roster: agent_id -> LLM mapping for the tournament.
//
// Lives in `@swarmwage/tournament-shared` so both:
//   - agent-runner (resolves Vercel AI SDK language-model instances)
//   - orchestrator (surfaces `model_label` on `/api/standings`)
// read from one source of truth. The Vercel-SDK resolver stays in
// agent-runner/src/llm.ts (provider clients are only built there); this
// module exposes only data + `pickModel`.

export type RosterProvider =
  | 'anthropic'
  | 'openai'
  | 'google'
  | 'mistral'
  | 'xai'
  | 'deepseek'
  | 'moonshot'
  | 'alibaba';

export type AgentKind = 'internal' | 'buyer';

export interface ModelSpec {
  /** Stable identifier used in logs + leaderboard. */
  id: string;
  /** Human-readable label shown on the leaderboard. */
  label: string;
  /** Provider key. */
  provider: RosterProvider;
  /** Provider-specific model ID. */
  model: string;
  /** Internal competitor or external buyer-agent. */
  kind: AgentKind;
}

/**
 * Default roster — verified 2026-05-22 (internal) + 2026-05-24 (buyer-agents).
 *
 * Internal-agent notes:
 * - o4-mini retired 2026-02-13 → replaced by gpt-5-mini.
 * - grok-3 declared legacy (some variants retired 2026-05-15) → grok-4.3.
 * - kimi-k2 base → kimi-k2-0905 (Sep-2025 stable; K2.6 too new to rely on).
 * - qwen DashScope wants the unhyphenated format `qwen2.5-72b-instruct`.
 *
 * Buyer-agent notes:
 * - Both buyers run Claude Haiku 4.5 (cheap + fast tool-loop) per
 *   `launch/tournament-design-v2.md` §Architecture.
 */
export const DEFAULT_ROSTER: readonly ModelSpec[] = [
  { id: 'agent_01', label: 'Claude Sonnet 4.6',  provider: 'anthropic', model: 'claude-sonnet-4-6',     kind: 'internal' },
  { id: 'agent_02', label: 'Claude Haiku 4.5',   provider: 'anthropic', model: 'claude-haiku-4-5',      kind: 'internal' },
  { id: 'agent_03', label: 'GPT-5',              provider: 'openai',    model: 'gpt-5',                  kind: 'internal' },
  { id: 'agent_04', label: 'GPT-5 Mini',         provider: 'openai',    model: 'gpt-5-mini',             kind: 'internal' },
  { id: 'agent_05', label: 'Gemini 2.5 Pro',     provider: 'google',    model: 'gemini-2.5-pro',         kind: 'internal' },
  { id: 'agent_06', label: 'Grok 4.3',           provider: 'xai',       model: 'grok-4.3',               kind: 'internal' },
  { id: 'agent_07', label: 'DeepSeek R1',        provider: 'deepseek',  model: 'deepseek-reasoner',      kind: 'internal' },
  // agent_08 model 2026-05-27: kimi-k2-0905 was withdrawn (404); the current
  // Kimi models kimi-k2.5 / kimi-k2.6 are *thinking* models that break the
  // AI-SDK multi-step tool flow ("reasoning_content missing in assistant tool
  // call message"). moonshot-v1-32k is the live non-thinking Moonshot model
  // that handles multi-step function calling cleanly. Honest relabel.
  { id: 'agent_08', label: 'Moonshot v1',        provider: 'moonshot',  model: 'moonshot-v1-32k',        kind: 'internal' },
  { id: 'agent_09', label: 'Mistral Large 2',    provider: 'mistral',   model: 'mistral-large-latest',   kind: 'internal' },
  // agent_10 swap 2026-05-24: Alibaba DashScope account verification stalled
  // (verification email never arrived). Substituted with Gemini 2.5 Flash —
  // reuses the existing Google AI Studio key (covers agent_05 Pro + agent_10
  // Flash). Adds a within-family Pro-vs-Flash tier comparison angle. If the
  // Alibaba verification lands before Mon 25 09:00, swap back to Qwen.
  { id: 'agent_10', label: 'Gemini 2.5 Flash',   provider: 'google',    model: 'gemini-2.5-flash',       kind: 'internal' },
  { id: 'buyer_01', label: 'Claude Haiku 4.5',   provider: 'anthropic', model: 'claude-haiku-4-5',      kind: 'buyer'    },
  { id: 'buyer_02', label: 'Claude Haiku 4.5',   provider: 'anthropic', model: 'claude-haiku-4-5',      kind: 'buyer'    },
];

export function pickModel(
  agentId: string,
  roster: readonly ModelSpec[] = DEFAULT_ROSTER,
): ModelSpec {
  const spec = roster.find((m) => m.id === agentId);
  if (!spec) {
    throw new Error(
      `no model assigned for agent ${agentId} (roster has ${roster.length} entries)`,
    );
  }
  return spec;
}

/** Lookup without throwing — returns undefined for unknown ids. */
export function tryPickModel(
  agentId: string,
  roster: readonly ModelSpec[] = DEFAULT_ROSTER,
): ModelSpec | undefined {
  return roster.find((m) => m.id === agentId);
}

export function internalAgents(
  roster: readonly ModelSpec[] = DEFAULT_ROSTER,
): readonly ModelSpec[] {
  return roster.filter((m) => m.kind === 'internal');
}

export function buyerAgents(
  roster: readonly ModelSpec[] = DEFAULT_ROSTER,
): readonly ModelSpec[] {
  return roster.filter((m) => m.kind === 'buyer');
}
