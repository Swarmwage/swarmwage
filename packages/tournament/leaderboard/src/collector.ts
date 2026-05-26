// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Swarmwage
//
// Reasoning + activity collector.
//
// Agents and buyer-agents POST their per-tick rationale + chosen action here
// over the *internal* Docker network (NO_PROXY already includes `leaderboard`,
// so this never touches the egress whitelist and costs no external bandwidth).
//
// This powers the two hardest views:
//   - "what the agents are doing"  (action: search / hire / publish / wait)
//   - "how they think"             (rationale: the LLM's short reasoning text)
//
// Everything is kept in-memory (ring buffers) — at 256MB with ~12 agents
// ticking every 2–5 min this is trivially small. No DB, no disk.

import { metaById } from './roster.js';

export interface TickRecord {
  ts: string;
  agent_id: string;
  model_label: string;
  kind: 'internal' | 'buyer' | 'unknown';
  tick: number | null;
  /** High-level action this tick: 'hire' | 'publish' | 'search' | 'wait' | 'sell' | ... */
  action: string | null;
  /** Short reasoning text from the LLM (truncated). */
  rationale: string | null;
  /** Optional structured detail (template, seller, price, capability, usdc, ...). */
  detail: Record<string, unknown> | null;
}

const PER_AGENT = Number(process.env.COLLECTOR_PER_AGENT ?? 40);
const GLOBAL = Number(process.env.COLLECTOR_GLOBAL ?? 400);

const perAgent = new Map<string, TickRecord[]>();
let global: TickRecord[] = [];

function clampStr(v: unknown, n: number): string | null {
  if (v == null) return null;
  const s = String(v);
  return s.length > n ? s.slice(0, n) + '…' : s;
}

export interface IngestInput {
  agent_id?: unknown;
  tick?: unknown;
  action?: unknown;
  rationale?: unknown;
  text?: unknown; // agent-runner uses result.text
  detail?: unknown;
}

export function ingestTick(body: IngestInput): TickRecord | { error: string } {
  const agent_id = typeof body.agent_id === 'string' ? body.agent_id : '';
  if (!agent_id) return { error: 'missing_agent_id' };
  const meta = metaById(agent_id);

  const rec: TickRecord = {
    ts: new Date().toISOString(),
    agent_id,
    model_label: meta?.label ?? agent_id,
    kind: meta?.kind ?? 'unknown',
    tick: Number.isFinite(Number(body.tick)) ? Number(body.tick) : null,
    action: clampStr(body.action, 40),
    rationale: clampStr(body.rationale ?? body.text, 600),
    detail:
      body.detail && typeof body.detail === 'object'
        ? (body.detail as Record<string, unknown>)
        : null,
  };

  const list = perAgent.get(agent_id) ?? [];
  list.push(rec);
  perAgent.set(agent_id, list.slice(-PER_AGENT));

  global.push(rec);
  if (global.length > GLOBAL) global = global.slice(-GLOBAL);

  return rec;
}

export function recentReasoning(limit = 60): TickRecord[] {
  return global.slice(-limit).reverse();
}

export function latestPerAgent(): TickRecord[] {
  const out: TickRecord[] = [];
  for (const list of perAgent.values()) {
    const last = list[list.length - 1];
    if (last) out.push(last);
  }
  return out.sort((a, b) => a.agent_id.localeCompare(b.agent_id));
}

export function agentTimeline(agentId: string, limit = 40): TickRecord[] {
  return (perAgent.get(agentId) ?? []).slice(-limit).reverse();
}
