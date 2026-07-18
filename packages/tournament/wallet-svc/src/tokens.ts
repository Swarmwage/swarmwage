// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Swarmwage

import { readFileSync } from 'node:fs';

/** Map agent_id → opaque bearer token (high-entropy secret). */
export type TokenStore = Record<string, string>;

/**
 * Load per-agent bearer tokens from `TOKENS_PATH`. JSON object mapping
 * agent_id → token string. Generated alongside the wallet roster
 * (scripts/generate-wallets.ts) and mounted from the same secrets volume.
 * NEVER baked into an image, NEVER committed to git.
 */
export function loadTokens(path: string): TokenStore {
  const raw = readFileSync(path, 'utf-8');
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const out: TokenStore = {};
  for (const [id, token] of Object.entries(parsed)) {
    if (typeof token !== 'string' || token.length < 16) {
      throw new Error(`Invalid token for agent ${id} (expected a string ≥16 chars)`);
    }
    out[id] = token;
  }
  if (Object.keys(out).length === 0) throw new Error('No tokens loaded');
  return out;
}

/**
 * Reverse a TokenStore into a token → agent_id lookup. Throws on a duplicate
 * token shared across agents (which would break the per-wallet binding).
 */
export function reverseTokens(tokens: TokenStore): Map<string, string> {
  const m = new Map<string, string>();
  for (const [id, token] of Object.entries(tokens)) {
    if (m.has(token)) throw new Error('Duplicate token shared across agents');
    m.set(token, id);
  }
  return m;
}
