// Swarmwage Facilitator — log store interface + in-memory implementation
// License: BUSL-1.1
//
// The store records every `/verify` and `/settle` interaction. The
// in-memory implementation is intended for development and the smoke
// tests; production deployments should swap in a Postgres adapter that
// targets the schema in `schema.sql`.

export type FacilitatorRoute = "verify" | "settle";

export interface FacilitatorLogEntry {
  ts: number;
  route: FacilitatorRoute;
  network: string;
  agent_id: string | null;
  capability: string | null;
  payer_address: string;
  recipient_address: string;
  amount_usdc_atomic: string;
  tx_hash: string | null;
  gas_eth_spent_wei: string | null;
  latency_ms: number;
  ok: boolean;
  error: string | null;
  raw_request: unknown;
  raw_response: unknown;
}

export interface FacilitatorLogStore {
  appendLog(entry: FacilitatorLogEntry): Promise<void>;
  /** Number of entries currently held. Useful for the smoke test only. */
  size(): Promise<number>;
}

/**
 * Bounded ring-buffer in-memory store. Caps memory usage at `maxEntries`
 * (default 10 000) so a long-running dev process does not leak unbounded.
 */
export class InMemoryStore implements FacilitatorLogStore {
  private readonly entries: FacilitatorLogEntry[] = [];
  private readonly maxEntries: number;

  constructor(maxEntries = 10_000) {
    this.maxEntries = maxEntries;
  }

  async appendLog(entry: FacilitatorLogEntry): Promise<void> {
    this.entries.push(entry);
    if (this.entries.length > this.maxEntries) {
      this.entries.splice(0, this.entries.length - this.maxEntries);
    }
  }

  async size(): Promise<number> {
    return this.entries.length;
  }

  /** Test-only accessor. Not part of `FacilitatorLogStore`. */
  snapshot(): readonly FacilitatorLogEntry[] {
    return this.entries.slice();
  }
}

// TODO: implement `PostgresStore` backed by `schema.sql`. The adapter
// should accept a `pg.Pool` (or a Supabase client) and stream writes
// non-blockingly so request handlers do not pay database latency.
