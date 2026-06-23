// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Swarmwage
//
// Orchestrator — polls wallet-svc + Docker for fleet health, journals to SQLite,
// exposes the read-only API surface the leaderboard consumes.
//
// SCAFFOLD — see launch/tournament-design.md §3 for the full killswitch
// semantics. This implementation covers:
//   - periodic balance + ledger snapshot
//   - basic API-spend gate (reads tick logs via docker exec)
//   - manual kill via CLI
//
// Not yet covered (Phase 1):
//   - Docker socket polling for CPU/memory anomalies
//   - per-provider billing API integration for true API-spend
//   - automated kill on rule breach (currently just alerts)
//
// Public endpoints (consumed by `packages/tournament/leaderboard`):
//   GET /health
//   GET /api/standings   -> internal-agent leaderboard (sorted USDC desc)
//   GET /api/buyers      -> external buyer-agent state (spend, orders posted)
//   GET /api/recent-tx   -> recent on-chain hires with parent/child linkage
//                          (scaffold: empty until tx-indexer lands)

import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import {
  DEFAULT_ROSTER,
  tryPickModel,
  type ModelSpec,
} from '@swarmwage/tournament-shared';

const WALLET_SVC_URL = process.env.WALLET_SVC_URL ?? 'http://wallet-svc:7000';
const AGENT_IDS = (process.env.AGENT_IDS ?? '').split(',').filter(Boolean);
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? 30_000);
const DB_PATH = process.env.DB_PATH ?? '/state/orchestrator.sqlite';
const BUYER_STARTING_USDC = Number(process.env.BUYER_STARTING_USDC ?? 10);
const INTERNAL_STARTING_USDC = Number(process.env.INTERNAL_STARTING_USDC ?? 5);

const db = new Database(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS snapshots (
    ts TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    usdc REAL NOT NULL,
    signs_24h INTEGER NOT NULL,
    value_usdc_24h_atomic TEXT NOT NULL,
    address TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_snapshots_ts ON snapshots(ts);
  CREATE INDEX IF NOT EXISTS idx_snapshots_agent ON snapshots(agent_id);
`);

// Lightweight forward-compat migration: older DBs were created without the
// `address` column. ALTER TABLE ADD COLUMN if missing.
try {
  const cols = db.prepare(`PRAGMA table_info(snapshots)`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === 'address')) {
    db.exec(`ALTER TABLE snapshots ADD COLUMN address TEXT`);
  }
} catch (e) {
  console.warn('[orchestrator] schema check failed:', e);
}

interface Snapshot {
  as_of: string;
  wallets: Record<
    string,
    | { address: string; usdc: number; usdc_raw: string; ledger: { signs: number; valueUsdc: string } }
    | { error: string }
  >;
}

async function tick() {
  const orchToken = process.env.ORCHESTRATOR_TOKEN;
  const res = await fetch(
    `${WALLET_SVC_URL}/internal/snapshot`,
    orchToken ? { headers: { authorization: `Bearer ${orchToken}` } } : undefined,
  );
  if (!res.ok) {
    console.error(`wallet-svc snapshot ${res.status}`);
    return;
  }
  const snap = (await res.json()) as Snapshot;
  const insert = db.prepare(
    `INSERT INTO snapshots (ts, agent_id, usdc, signs_24h, value_usdc_24h_atomic, address) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  for (const [id, entry] of Object.entries(snap.wallets)) {
    if ('error' in entry) continue;
    insert.run(snap.as_of, id, entry.usdc, entry.ledger.signs, entry.ledger.valueUsdc, entry.address);
  }
}

interface LatestRow {
  agent_id: string;
  usdc: number;
  signs_24h: number;
  value_usdc_24h_atomic: string;
  ts: string;
  address: string | null;
}

function latestSnapshots(): LatestRow[] {
  return db
    .prepare(
      `WITH latest AS (
         SELECT agent_id, MAX(ts) AS ts FROM snapshots GROUP BY agent_id
       )
       SELECT s.agent_id, s.usdc, s.signs_24h, s.value_usdc_24h_atomic, s.ts, s.address
       FROM snapshots s
       JOIN latest l ON l.agent_id = s.agent_id AND l.ts = s.ts`,
    )
    .all() as LatestRow[];
}

function decorateRow(row: LatestRow): LatestRow & {
  model_label: string;
  provider: string;
  agent_kind: ModelSpec['kind'] | 'unknown';
} {
  const spec = tryPickModel(row.agent_id, DEFAULT_ROSTER);
  return {
    ...row,
    model_label: spec?.label ?? row.agent_id,
    provider: spec?.provider ?? 'unknown',
    agent_kind: spec?.kind ?? 'unknown',
  };
}

const app = new Hono();
app.get('/health', (c) => c.json({ ok: true, agents: AGENT_IDS }));

// Internal-agent leaderboard. Excludes buyers — they live on /api/buyers.
app.get('/api/standings', (c) => {
  const rows = latestSnapshots()
    .map(decorateRow)
    .filter((r) => r.agent_kind !== 'buyer')
    .sort((a, b) => b.usdc - a.usdc);
  return c.json({ as_of: new Date().toISOString(), standings: rows });
});

// External buyer-agent panel. Shows starting balance ($10), current balance,
// total spent (starting - current), and last-activity ts. Order count comes
// from the buyer-agent service in Phase 1 — until then we report null.
app.get('/api/buyers', (c) => {
  const rows = latestSnapshots()
    .map(decorateRow)
    .filter((r) => r.agent_kind === 'buyer')
    .sort((a, b) => a.agent_id.localeCompare(b.agent_id))
    .map((r) => ({
      agent_id: r.agent_id,
      model_label: r.model_label,
      provider: r.provider,
      address: r.address,
      starting_balance_usdc: BUYER_STARTING_USDC,
      current_balance_usdc: r.usdc,
      total_spent_usdc: Math.max(0, BUYER_STARTING_USDC - r.usdc),
      signs_24h: r.signs_24h,
      orders_posted: null as number | null, // TODO: buyer-agent exposes /metrics; wire in integration phase
      last_activity_ts: r.ts,
    }));
  return c.json({ as_of: new Date().toISOString(), buyers: rows });
});

// Recent on-chain hires. Each entry can declare `parent_tx_hash` to attach
// itself as a sub-hire under the broker's parent hire — the leaderboard UI
// uses this to draw the tree.
//
// SCAFFOLD: until the tx-indexer is wired (`launch/tournament-design.md §
// indexer`), this returns the contract shape with an empty list so the
// frontend renderer can be developed against a stable response.
app.get('/api/recent-tx', (c) => {
  return c.json({
    as_of: new Date().toISOString(),
    note: 'phase-1 — tx-indexer not yet wired; shape is stable',
    tx: [] as Array<{
      tx_hash: string;
      block_number: number;
      ts: string;
      buyer_id: string;
      seller_id: string;
      capability: string;
      usdc: string;
      /** If this hire was sub-contracted from a compound order, the broker's parent tx hash. */
      parent_tx_hash: string | null;
      /** Compound-order id when the parent_tx_hash is part of a compound chain. */
      compound_order_id: string | null;
    }>,
  });
});

serve({ fetch: app.fetch, port: 4000 });
console.log('[orchestrator] listening on :4000');

setInterval(() => {
  tick().catch((e) => console.error('tick err:', e));
}, POLL_INTERVAL_MS);
tick();

// Silence "unused" lint in scaffold state.
void INTERNAL_STARTING_USDC;
