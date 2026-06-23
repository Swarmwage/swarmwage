// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Swarmwage
//
// wallet-svc — sign-only sidecar for the agent tournament.
//
// Entrypoint: loads secrets from disk, builds the app (see app.ts), and serves
// on the internal Docker network only. Keys are never returned over the wire
// and never logged.
//
// Auth: per-wallet bearer tokens (see auth.ts + tokens.ts) bind a caller to
// exactly one wallet id. Enabled by default; `WALLET_SVC_AUTH=off` disables it
// for LOCAL DEV ONLY (loud warning at boot). Per-wallet caps remain a secondary
// limiter, not the authorization boundary.

import { serve } from '@hono/node-server';
import { loadCaps, type Caps } from './caps.js';
import { loadWallets, type WalletStore } from './wallets.js';
import { loadTokens, type TokenStore } from './tokens.js';
import { CapLedger } from './cap-ledger.js';
import { createApp } from './app.js';

const PORT = Number(process.env.PORT ?? 7000);
const WALLETS_PATH = process.env.WALLETS_PATH ?? '/secrets/wallets.json';
const CAPS_PATH = process.env.CAPS_PATH ?? '/secrets/caps.json';
const TOKENS_PATH = process.env.TOKENS_PATH ?? '/secrets/tokens.json';
const LEDGER_PATH = process.env.LEDGER_PATH ?? '/state/cap-ledger.json';

const wallets: WalletStore = loadWallets(WALLETS_PATH);
const caps: Caps = loadCaps(CAPS_PATH);
const ledger = new CapLedger(LEDGER_PATH);

const authEnabled = process.env.WALLET_SVC_AUTH !== 'off';
let tokens: TokenStore | undefined;
if (authEnabled) {
  // Fail-closed: refuse to boot with auth on but no tokens to enforce.
  tokens = loadTokens(TOKENS_PATH);
} else {
  console.warn(
    '[wallet-svc] ⚠ WALLET_SVC_AUTH=off — /wallets routes are UNAUTHENTICATED. ' +
      'LOCAL DEV ONLY; never in a funded/tournament environment.',
  );
}

const app = createApp({
  wallets,
  caps,
  ledger,
  tokens,
  orchestratorToken: process.env.ORCHESTRATOR_TOKEN ?? null,
  authEnabled,
});

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(
    `[wallet-svc] listening on :${info.port} — ${Object.keys(wallets).length} wallets — auth ${authEnabled ? 'ON' : 'OFF (dev)'}`,
  );
});
