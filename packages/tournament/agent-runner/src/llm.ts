// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Swarmwage
//
// Per-agent LLM selection. Wraps Vercel AI SDK providers.
//
// Roster definition has moved to `@swarmwage/tournament-shared/roster` so the
// orchestrator (which can't depend on Vercel-SDK provider modules) can read
// the same `agent_id -> {label, provider, model, kind}` mapping. This file
// keeps the Vercel-SDK provider client construction + `resolveLanguageModel`
// which is agent-runner-only.

import { anthropic } from '@ai-sdk/anthropic';
import { openai, createOpenAI } from '@ai-sdk/openai';
import { google } from '@ai-sdk/google';
import { mistral } from '@ai-sdk/mistral';
import {
  DEFAULT_ROSTER as SHARED_ROSTER,
  pickModel as sharedPickModel,
  type ModelSpec,
} from '@swarmwage/tournament-shared';

export type { ModelSpec } from '@swarmwage/tournament-shared';

// Re-export with a mutable-array signature for any pre-existing call sites
// that passed in a custom roster. Internally we never mutate.
export const DEFAULT_ROSTER: ModelSpec[] = [...SHARED_ROSTER];

export function pickModel(
  agentId: string,
  roster: ModelSpec[] = DEFAULT_ROSTER,
): ModelSpec {
  return sharedPickModel(agentId, roster);
}

// OpenAI-compatible providers — built once at module load, reused per call.
// Each needs its own API key env var; the spawn (docker compose / dev) is
// responsible for setting them.
const xaiProvider = createOpenAI({
  baseURL: 'https://api.x.ai/v1',
  apiKey: process.env.XAI_API_KEY ?? '',
});
const deepseekProvider = createOpenAI({
  baseURL: 'https://api.deepseek.com/v1',
  apiKey: process.env.DEEPSEEK_API_KEY ?? '',
});
const moonshotProvider = createOpenAI({
  baseURL: 'https://api.moonshot.ai/v1',
  apiKey: process.env.MOONSHOT_API_KEY ?? '',
});
const alibabaProvider = createOpenAI({
  baseURL: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
  apiKey: process.env.ALIBABA_API_KEY ?? '',
});

/**
 * Resolve a `language-model` provider+model to a Vercel AI SDK `LanguageModel`
 * instance. Providers without first-party Vercel SDK support (xAI, DeepSeek,
 * Moonshot, Alibaba) use OpenAI-compatible adapters via `createOpenAI`.
 */
export function resolveLanguageModel(spec: ModelSpec) {
  switch (spec.provider) {
    case 'anthropic':
      return anthropic(spec.model);
    case 'openai':
      // structuredOutputs:false disables OpenAI strict function-schema mode.
      // Strict mode rejects our tool schemas (optional fields, z.record) with
      // "'required' must include every key" / "additionalProperties needs a
      // type", which silently killed every GPT-5 / GPT-5-mini tick. The other
      // providers don't enforce strict, so this is OpenAI-only.
      return openai(spec.model, { structuredOutputs: false });
    case 'google':
      return google(spec.model);
    case 'mistral':
      return mistral(spec.model);
    case 'xai':
      return xaiProvider(spec.model);
    case 'deepseek':
      return deepseekProvider(spec.model);
    case 'moonshot':
      return moonshotProvider(spec.model);
    case 'alibaba':
      return alibabaProvider(spec.model);
    default:
      throw new Error(`unsupported provider: ${(spec as ModelSpec).provider}`);
  }
}
