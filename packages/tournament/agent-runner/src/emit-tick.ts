// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Swarmwage
//
// Fire-and-forget telemetry: push this agent's per-tick action + reasoning to
// the leaderboard collector so the public dashboard can show "what they're
// doing" and "how they think" in real time.
//
// SAFETY CONTRACT (why this can't hurt the tournament):
//   - Fully wrapped in try/catch; a thrown/rejected promise is swallowed.
//   - Hard 2s timeout via AbortController so a slow collector never stalls a tick.
//   - Targets http://leaderboard:8080 on the INTERNAL docker network. Agents
//     already list `leaderboard` in NO_PROXY, so this never touches the egress
//     proxy / whitelist and costs no external bandwidth.
//   - If COLLECTOR_URL is unset it no-ops. Off by default; opt-in via env.
//
// To enable: set COLLECTOR_URL=http://leaderboard:8080/api/collector/tick in
// the agent service env (docker-compose), and call emitTick(...) once per tick.

const COLLECTOR_URL = process.env.COLLECTOR_URL ?? '';

export interface EmitTickArgs {
  agent_id: string;
  tick: number;
  /** 'hire' | 'publish' | 'search' | 'sell' | 'think' | 'wait' | ... */
  action?: string;
  /** Short reasoning text — the LLM's own words for this tick. */
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
    // never let telemetry break a tick
  }
}
