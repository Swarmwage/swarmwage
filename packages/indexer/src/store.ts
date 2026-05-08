// Swarmwage Indexer — store interface + in-memory implementation
// License: BUSL-1.1
//
// The store persists indexed USDC Transfer events and the per-chain
// `last_indexed_block` cursor. The in-memory implementation is intended
// for local development and the smoke tests; production deployments
// should swap in a Postgres adapter that targets the schema in
// `schema.sql`.

export interface IndexedTransaction {
  chain_id: number;
  block_number: bigint;
  log_index: number;
  tx_hash: string;
  from_address: string;
  to_address: string;
  /**
   * The agent identifier resolved from the registry, or `null` if the
   * recipient address is not (yet) registered. Indexing proceeds either
   * way — the registry mapping can be backfilled later.
   */
  recipient_agent_id: string | null;
  /** USDC atomic units (6 decimals). Stored as bigint to avoid precision loss. */
  value_usdc_atomic: bigint;
  /** Unix timestamp in seconds at which the block was mined. */
  ts: number;
}

export interface IndexerStore {
  /**
   * Insert a batch of indexed transactions. Implementations MUST treat
   * `(chain_id, block_number, log_index)` as the natural key and dedupe
   * idempotently — the indexer may replay ranges on restart.
   */
  upsertTransactions(transactions: IndexedTransaction[]): Promise<void>;
  /** Read the persisted cursor for a given chain. Returns `null` on first boot. */
  getLastIndexedBlock(chainId: number): Promise<bigint | null>;
  /** Persist the cursor after a successful range write. */
  setLastIndexedBlock(chainId: number, block: bigint): Promise<void>;
  /** Total transaction count. Useful for `/health` and the smoke test. */
  size(): Promise<number>;
}

/**
 * Bounded ring-buffer in-memory store. Caps memory usage at `maxEntries`
 * (default 100 000) so a long-running dev process does not leak unbounded.
 */
export class InMemoryStore implements IndexerStore {
  private readonly entries: IndexedTransaction[] = [];
  private readonly maxEntries: number;
  private readonly seen = new Set<string>();
  private readonly cursors = new Map<number, bigint>();

  constructor(maxEntries = 100_000) {
    this.maxEntries = maxEntries;
  }

  async upsertTransactions(transactions: IndexedTransaction[]): Promise<void> {
    for (const tx of transactions) {
      const key = `${tx.chain_id}:${tx.block_number}:${tx.log_index}`;
      if (this.seen.has(key)) continue;
      this.seen.add(key);
      this.entries.push(tx);
    }
    if (this.entries.length > this.maxEntries) {
      const overflow = this.entries.length - this.maxEntries;
      const dropped = this.entries.splice(0, overflow);
      for (const tx of dropped) {
        this.seen.delete(`${tx.chain_id}:${tx.block_number}:${tx.log_index}`);
      }
    }
  }

  async getLastIndexedBlock(chainId: number): Promise<bigint | null> {
    return this.cursors.get(chainId) ?? null;
  }

  async setLastIndexedBlock(chainId: number, block: bigint): Promise<void> {
    this.cursors.set(chainId, block);
  }

  async size(): Promise<number> {
    return this.entries.length;
  }

  /** Test-only accessor. Not part of `IndexerStore`. */
  snapshot(): readonly IndexedTransaction[] {
    return this.entries.slice();
  }
}

// TODO: implement `PostgresStore` backed by `schema.sql`. The adapter
// should accept a `pg.Pool` (or a Supabase client) and use
// `INSERT ... ON CONFLICT (chain_id, block_number, log_index) DO NOTHING`
// to remain idempotent under restart. The cursor table (`indexer_state`)
// uses `INSERT ... ON CONFLICT (chain_id) DO UPDATE`.
