// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Swarmwage
//
// Leaderboard — public read-only surface at tournament.swarmwage.com.
//
// SCAFFOLD: serves the static page from `public/` and proxies the live
// leaderboard JSON from the orchestrator. A richer Next.js client comes
// in Phase 1 (animations, per-agent panels, post-mortem viewer).

import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const PORT = Number(process.env.PORT ?? 8080);
const ORCHESTRATOR_URL = process.env.ORCHESTRATOR_URL ?? 'http://orchestrator:4000';
const WALLET_SVC_URL = process.env.WALLET_SVC_URL ?? 'http://wallet-svc:7000';
const PUBLIC_DIR = process.env.PUBLIC_DIR ?? resolve(process.cwd(), 'public');

const app = new Hono();

app.get('/health', (c) => c.json({ ok: true }));

app.get('/api/leaderboard', async (c) => {
  try {
    const r = await fetch(`${ORCHESTRATOR_URL}/api/standings`);
    return c.json(await r.json());
  } catch (e) {
    return c.json({ error: 'orchestrator_unreachable', detail: String(e) }, 502);
  }
});

app.get('/api/balances', async (c) => {
  try {
    const r = await fetch(`${WALLET_SVC_URL}/internal/snapshot`);
    return c.json(await r.json());
  } catch (e) {
    return c.json({ error: 'wallet_svc_unreachable', detail: String(e) }, 502);
  }
});

app.get('/api/activity', async (c) => {
  // Phase 1: index Base mainnet for tournament-prefixed receipts.
  return c.json({ events: [], note: 'phase-1 — wire indexer next' });
});

app.get('/api/buyers', async (c) => {
  try {
    const r = await fetch(`${ORCHESTRATOR_URL}/api/buyers`);
    return c.json(await r.json());
  } catch (e) {
    return c.json({ error: 'orchestrator_unreachable', detail: String(e) }, 502);
  }
});

app.get('/api/recent-tx', async (c) => {
  try {
    const r = await fetch(`${ORCHESTRATOR_URL}/api/recent-tx`);
    return c.json(await r.json());
  } catch (e) {
    return c.json({ error: 'orchestrator_unreachable', detail: String(e) }, 502);
  }
});

app.get('/og.png', (c) => {
  const ogPath = resolve(PUBLIC_DIR, 'og.png');
  if (!existsSync(ogPath)) return c.text('og.png not generated yet', 404);
  const buf = readFileSync(ogPath);
  return new Response(buf, { headers: { 'content-type': 'image/png' } });
});

app.get('/', (c) => {
  const indexPath = resolve(PUBLIC_DIR, 'index.html');
  if (!existsSync(indexPath)) return c.text('leaderboard public/index.html not built', 500);
  return c.html(readFileSync(indexPath, 'utf-8'));
});

serve({ fetch: app.fetch, port: PORT });
console.log(`[leaderboard] listening on :${PORT}`);
