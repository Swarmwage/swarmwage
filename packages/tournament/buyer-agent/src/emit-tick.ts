// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Swarmwage
//
// Fire-and-forget telemetry for buyer-agents: push the per-tick action +
// rationale to the leaderboard collector for the public dashboard.
//
// Same safety contract as agent-runner/src/emit-tick.ts: try/catch wrapped,
// 2s timeout, internal-network only, no-op unless COLLECTOR_URL is set.

const COLLECTOR_URL = process.env.COLLECTOR_URL ?? '';

export interface EmitTickArgs {
  agent_id: string;
  tick: number;
  action?: string;
  rationale?: string;
  detail?: Record<string, unknown>;
}

export function emitTick(args: EmitTickArgs): void {
  if (!COLLECTOR_URL) return;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2000);
    fetch(COLLECTOR_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agent_id: args.agent_id,
        tick: args.tick,
        action: args.action ?? null,
        rationale: args.rationale ?? null,
        detail: args.detail ?? null,
      }),
      signal: ctrl.signal,
    })
      .catch(() => {})
      .finally(() => clearTimeout(t));
  } catch {
    /* never break a tick */
  }
}
