// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Swarmwage
//
// One-shot LLM smoke for a single agent slot. No wallet-svc, no x402,
// no tournament state — just verify that the configured provider for
// AGENT_ID actually responds to a 1-token prompt within a sane latency.
//
// Burns ~10-50 tokens (~$0.0001 worst case). Catches provider misconfig
// BEFORE funding the live tournament wallets.
//
// Usage (from packages/tournament/):
//   AGENT_ID=agent_05 tsx agent-runner/src/smoke.ts
//
// Or run all 10 via the bash wrapper:
//   pnpm smoke
//
// Exit codes:
//   0 — smoke OK
//   1 — smoke FAIL (provider error, network issue, key invalid, etc.)
//   2 — SKIP (provider API key not in env; expected when smoking partial
//       roster before all 6 extra keys are collected)

import { generateText } from 'ai';
import { pickModel, resolveLanguageModel, type ModelSpec } from './llm.js';

const AGENT_ID = process.env.AGENT_ID;
if (!AGENT_ID) {
  console.error('smoke: AGENT_ID env var required (e.g. AGENT_ID=agent_05)');
  process.exit(1);
}

const PROVIDER_ENV: Record<ModelSpec['provider'], string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GOOGLE_GENERATIVE_AI_API_KEY',
  mistral: 'MISTRAL_API_KEY',
  xai: 'XAI_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  moonshot: 'MOONSHOT_API_KEY',
  alibaba: 'ALIBABA_API_KEY',
};

(async () => {
  let spec: ModelSpec;
  try {
    spec = pickModel(AGENT_ID);
  } catch (err) {
    console.error(`[${AGENT_ID}] FAIL: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }

  const envVar = PROVIDER_ENV[spec.provider];
  if (!process.env[envVar]) {
    console.log(
      `[${AGENT_ID}] SKIP provider=${spec.provider} reason="missing ${envVar}" — set the key and re-run`,
    );
    process.exit(2);
  }

  console.log(
    `[${AGENT_ID}] smoking model=${spec.model} provider=${spec.provider} label="${spec.label}"`,
  );

  const model = resolveLanguageModel(spec);
  const t0 = Date.now();
  try {
    const result = await generateText({
      model,
      prompt: 'Reply with exactly the single token: OK',
      maxTokens: 10,
    });
    const elapsed = Date.now() - t0;
    const tokensIn = result.usage?.promptTokens ?? 0;
    const tokensOut = result.usage?.completionTokens ?? 0;
    const preview = result.text.trim().replace(/\s+/g, ' ').slice(0, 60) || '(empty)';
    console.log(
      `[${AGENT_ID}] OK latency=${elapsed}ms tokens=${tokensIn}/${tokensOut} response="${preview}"`,
    );
    process.exit(0);
  } catch (err) {
    const elapsed = Date.now() - t0;
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[${AGENT_ID}] FAIL latency=${elapsed}ms error="${msg.slice(0, 240)}"`);
    process.exit(1);
  }
})();
