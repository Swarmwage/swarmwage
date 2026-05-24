// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Swarmwage

import { readFileSync } from 'node:fs';

export type CapEntry = {
  /** Max number of signature requests per UTC day. */
  maxSignsPerDay: number;
  /** Max total USDC value signed per UTC day (in 6-decimal base units, as BigInt). */
  maxValueUsdcPerDay: bigint;
};

export type Caps = {
  default: CapEntry;
  [agentId: string]: CapEntry;
};

/**
 * Load per-agent + default caps from JSON. JSON encodes BigInt as decimal string.
 *
 * Example file:
 * ```json
 * {
 *   "default": { "maxSignsPerDay": 500, "maxValueUsdcPerDay": "10000000" },
 *   "agent_03": { "maxSignsPerDay": 200, "maxValueUsdcPerDay": "5000000" }
 * }
 * ```
 *
 * 10_000_000 base units = 10 USDC.
 */
export function loadCaps(path: string): Caps {
  const raw = readFileSync(path, 'utf-8');
  const parsed = JSON.parse(raw) as Record<string, { maxSignsPerDay: number; maxValueUsdcPerDay: string }>;
  if (!parsed.default) throw new Error('caps.json must define a "default" entry');
  const out = {} as Caps;
  for (const [id, entry] of Object.entries(parsed)) {
    out[id] = {
      maxSignsPerDay: entry.maxSignsPerDay,
      maxValueUsdcPerDay: BigInt(entry.maxValueUsdcPerDay),
    };
  }
  return out;
}
