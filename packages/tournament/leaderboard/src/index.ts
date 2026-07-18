// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Swarmwage
//
// Leaderboard — public real-time observability surface at
// tournament.swarmwage.com.
//
// Serves the static dashboard from `public/` and exposes the live data the UI
// polls. Five views:
//   1. fund flow      -> /api/flow      (on-chain USDC transfers between the
//                                        12 tournament wallets, this process
//                                        indexes Base mainnet directly)
//   2. leaderboard    -> /api/leaderboard (proxied orchestrator standings)
//   3+4. activity +   -> /api/reasoning (agents POST per-tick action+rationale
//        reasoning        to /api/collector/tick over the internal network)
//   5. pulse          -> /api/activity  (merged flow + reasoning stream)

import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { startFlowIndexer, flowSnapshot } from './flow-indexer.js';
import {
  ingestTick,
  recentReasoning,
  latestPerAgent,
  agentTimeline,
} from './collector.js';
import { ROSTER } from './roster.js';

const PORT = Number(process.env.PORT ?? 8080);
const ORCHESTRATOR_URL = process.env.ORCHESTRATOR_URL ?? 'http://orchestrator:4000';
const WALLET_SVC_URL = process.env.WALLET_SVC_URL ?? 'http://wallet-svc:7000';
const PUBLIC_DIR = process.env.PUBLIC_DIR ?? resolve(process.cwd(), 'public');

const app = new Hono();

app.get('/health', (c) =>
  c.json({ ok: true, flow: flowSnapshot(1).last_block, roster: ROSTER.length }),
);

// Static roster (model labels + addresses) — lets the UI render before any
// orchestrator/flow data has arrived.
app.get('/api/roster', (c) =>
  c.json({
    agents: ROSTER.map((a) => ({
      agent_id: a.agent_id,
      label: a.label,
      provider: a.provider,
      kind: a.kind,
      address: a.address,
    })),
  }),
);

app.get('/api/leaderboard', async (c) => {
  try {
    const r = await fetch(`${ORCHESTRATOR_URL}/api/standings`);
    return c.json(await r.json());
  } catch (e) {
    return c.json({ error: 'orchestrator_unreachable', detail: String(e), standings: [] }, 200);
  }
});

app.get('/api/buyers', async (c) => {
  try {
    const r = await fetch(`${ORCHESTRATOR_URL}/api/buyers`);
    return c.json(await r.json());
  } catch (e) {
    return c.json({ error: 'orchestrator_unreachable', detail: String(e), buyers: [] }, 200);
  }
});

// --- Fund flow (on-chain, indexed in-process) ---
app.get('/api/flow', (c) => {
  const limit = Math.min(200, Number(c.req.query('limit') ?? 60));
  return c.json(flowSnapshot(limit));
});

// --- Reasoning + per-agent activity (collector-fed) ---
// Agents fire-and-forget POST here every tick. Internal network only.
app.post('/api/collector/tick', async (c) => {
  try {
    const body = await c.req.json();
    const r = ingestTick(body);
    if ('error' in r) return c.json(r, 400);
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ error: 'bad_body', detail: String(e) }, 400);
  }
});

app.get('/api/reasoning', (c) => {
  const limit = Math.min(200, Number(c.req.query('limit') ?? 60));
  return c.json({ as_of: new Date().toISOString(), ticks: recentReasoning(limit) });
});

app.get('/api/agents/latest', (c) =>
  c.json({ as_of: new Date().toISOString(), agents: latestPerAgent() }),
);

app.get('/api/agents/:id/timeline', (c) => {
  const limit = Math.min(100, Number(c.req.query('limit') ?? 40));
  return c.json({ agent_id: c.req.param('id'), timeline: agentTimeline(c.req.param('id'), limit) });
});

// --- Merged "pulse" feed: on-chain transfers + agent actions, time-sorted ---
app.get('/api/activity', (c) => {
  const flow = flowSnapshot(80).events.map((e) => ({
    type: 'transfer' as const,
    ts: new Date(e.ts || Date.now()).toISOString(),
    from_label: e.from_label,
    to_label: e.to_label,
    usdc: e.usdc,
    edge_kind: e.edge_kind,
    tx_hash: e.tx_hash,
  }));
  const acts = recentReasoning(80).map((t) => ({
    type: 'action' as const,
    ts: t.ts,
    agent_id: t.agent_id,
    model_label: t.model_label,
    action: t.action,
    rationale: t.rationale,
    detail: t.detail,
  }));
  const merged = [...flow, ...acts].sort((a, b) => (a.ts < b.ts ? 1 : -1)).slice(0, 120);
  return c.json({ as_of: new Date().toISOString(), events: merged });
});

// Legacy endpoint kept for the agents' `recent_market_activity` tool, which
// fetches /api/activity expecting an `events` array — preserved above.
app.get('/api/recent-tx', (c) => {
  // Map the on-chain flow into the parent/child tx shape the old UI used.
  const events = flowSnapshot(60).events.map((e) => ({
    tx_hash: e.tx_hash,
    block_number: e.block_number,
    ts: new Date(e.ts || Date.now()).toISOString(),
    buyer_id: e.from_label,
    seller_id: e.to_label,
    capability: e.edge_kind,
    usdc: e.usdc,
    parent_tx_hash: null,
    compound_order_id: null,
  }));
  return c.json({ as_of: new Date().toISOString(), tx: events });
});

// --- Seller hire ingress proxy ---
// Agents register their seller endpoint as
//   https://tournament.swarmwage.com/agent/<agent_id>/capabilities/<name>
// (the registry rejects private/loopback endpoints, so we cannot publish the
// internal http://agent_NN:3000 URL directly). Caddy forwards the whole host
// to this leaderboard container, which sits on the INTERNAL network and can
// reach each agent at http://<agent_id>:3000. We proxy /agent/<id>/<rest> →
// http://<id>:3000/<rest>. <id> is validated against the roster to prevent
// SSRF — only known tournament agent_ids are reachable.
const KNOWN_IDS = new Set(ROSTER.map((a) => a.agent_id));

app.all('/agent/:id/*', async (c) => {
  const id = c.req.param('id');
  if (!KNOWN_IDS.has(id)) return c.json({ error: 'unknown_agent' }, 404);
  // Strip the `/agent/<id>` prefix; forward the remainder + query.
  const url = new URL(c.req.url);
  const prefix = `/agent/${id}`;
  const rest = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : url.pathname;
  const target = `http://${id}:3000${rest}${url.search}`;
  const init: RequestInit = {
    method: c.req.method,
    headers: c.req.raw.headers,
    body:
      c.req.method === 'GET' || c.req.method === 'HEAD'
        ? undefined
        : await c.req.raw.arrayBuffer(),
  };
  try {
    const upstream = await fetch(target, init);
    const headers = new Headers(upstream.headers);
    headers.delete('content-encoding');
    headers.delete('content-length');
    return new Response(upstream.body, { status: upstream.status, headers });
  } catch (e) {
    return c.json({ error: 'agent_unreachable', detail: String(e) }, 502);
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

startFlowIndexer();
serve({ fetch: app.fetch, port: PORT });
console.log(`[leaderboard] listening on :${PORT}`);

void WALLET_SVC_URL;
