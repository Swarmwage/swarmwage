// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Swarmwage

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

type Usage = {
  signs: number;
  valueUsdc: bigint;
};

type Record_ = {
  ts: number; // epoch ms
  signs: number;
  valueUsdc: string; // BigInt as decimal string
  kind: 'transfer-authorization' | 'receipt' | 'listing' | 'message' | 'typed-data';
};

type Persisted = Record<string, Record_[]>;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Sliding-24h-window ledger of sign attempts per agent. Persisted to disk
 * (single JSON file) so caps survive restart.
 *
 * Two cap dimensions enforced upstream by wallet-svc:
 *   - signs per 24h rolling window
 *   - value (USDC base units) signed in 24h rolling window
 *
 * Both are reset by sliding window, NOT by UTC day boundary, so an attacker
 * cannot wait until 23:59 UTC to drain.
 */
export class CapLedger {
  private store: Persisted = {};

  constructor(private readonly path: string) {
    if (existsSync(path)) {
      const raw = readFileSync(path, 'utf-8');
      this.store = JSON.parse(raw);
    } else {
      mkdirSync(dirname(path), { recursive: true });
      this.persist();
    }
  }

  private persist() {
    writeFileSync(this.path, JSON.stringify(this.store), 'utf-8');
  }

  usage(agentId: string): Usage {
    const cutoff = Date.now() - DAY_MS;
    const records = (this.store[agentId] ?? []).filter((r) => r.ts >= cutoff);
    let signs = 0;
    let valueUsdc = 0n;
    for (const r of records) {
      signs += r.signs;
      valueUsdc += BigInt(r.valueUsdc);
    }
    return { signs, valueUsdc };
  }

  record(
    agentId: string,
    entry: { signs: number; valueUsdc: bigint; kind: Record_['kind'] },
  ) {
    const cutoff = Date.now() - DAY_MS;
    const existing = (this.store[agentId] ?? []).filter((r) => r.ts >= cutoff);
    existing.push({ ts: Date.now(), signs: entry.signs, valueUsdc: entry.valueUsdc.toString(), kind: entry.kind });
    this.store[agentId] = existing;
    this.persist();
  }
}
