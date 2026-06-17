// Swarmwage Indexer — store interface + implementations
// License: BUSL-1.1
//
// The store persists indexed USDC Transfer events and the per-chain
// `last_indexed_block` cursor. Two implementations are provided:
// `InMemoryStore` for local development and the smoke tests, and
// `PostgresStore` for production deployments. Both satisfy
// `IndexerStore` and are interchangeable at the boot boundary based on
// the presence of `DATABASE_URL`.

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
  /**
   * Provenance of an *external* (non-Swarmwage) recipient, e.g.
   * "example-catalog", or `null` when the address is unknown or is one of our
   * own registered agents. Orthogonal to `recipient_agent_id`.
   */
  recipient_source?: string | null;
  /** Human label for an external recipient, e.g. "Example Service". `null` when unknown. */
  recipient_label?: string | null;
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

// ---------------------------------------------------------------------------
// PostgresStore
// ---------------------------------------------------------------------------

import postgres from "postgres";
type Sql = postgres.Sql<{ bigint: bigint }>;

export interface PostgresStoreOptions {
  /** Postgres connection string. Pooler URL recommended for serverless. */
  connectionString: string;
  /** Max pool connections. Defaults to 5 — Supabase Transaction pooler safe. */
  max?: number;
}

/**
 * Postgres-backed implementation of `IndexerStore`. Uses `ON CONFLICT
 * DO NOTHING` on the `(chain_id, block_number, log_index)` natural key
 * so range replays after restart remain idempotent. The cursor table
 * (`indexer_state`) uses `ON CONFLICT (chain_id) DO UPDATE`.
 *
 * Schema: `packages/indexer/schema.sql`.
 */
export class PostgresStore implements IndexerStore {
  private readonly sql: Sql;

  constructor(opts: PostgresStoreOptions) {
    this.sql = postgres(opts.connectionString, {
      max: opts.max ?? 5,
      // PgBouncer (Supavisor transaction-mode pooler) is incompatible
      // with prepared statements. Disable so we work seamlessly behind
      // the connection pooler on port 6543.
      prepare: false,
      types: {
        bigint: postgres.BigInt,
      },
    });
  }

  async upsertTransactions(transactions: IndexedTransaction[]): Promise<void> {
    if (transactions.length === 0) return;
    // postgres-js bulk insert via `sql(values, ...keys)` shorthand. The
    // `ON CONFLICT (chain_id, block_number, log_index) DO NOTHING` clause
    // dedupes block-range replays after restart.
    const rows = transactions.map((tx) => ({
      chain_id: tx.chain_id,
      block_number: tx.block_number,
      log_index: tx.log_index,
      tx_hash: tx.tx_hash,
      from_address: tx.from_address,
      to_address: tx.to_address,
      recipient_agent_id: tx.recipient_agent_id,
      recipient_source: tx.recipient_source ?? null,
      recipient_label: tx.recipient_label ?? null,
      value_usdc_atomic: tx.value_usdc_atomic,
      ts: new Date(tx.ts * 1000),
    }));
    await this.sql`
      INSERT INTO transactions ${this.sql(
        rows,
        "chain_id",
        "block_number",
        "log_index",
        "tx_hash",
        "from_address",
        "to_address",
        "recipient_agent_id",
        "recipient_source",
        "recipient_label",
        "value_usdc_atomic",
        "ts",
      )}
      ON CONFLICT (chain_id, block_number, log_index) DO NOTHING
    `;
  }

  async getLastIndexedBlock(chainId: number): Promise<bigint | null> {
    const rows = await this.sql<{ last_indexed_block: bigint }[]>`
      SELECT last_indexed_block
      FROM indexer_state
      WHERE chain_id = ${chainId}
    `;
    return rows[0]?.last_indexed_block ?? null;
  }

  async setLastIndexedBlock(chainId: number, block: bigint): Promise<void> {
    await this.sql`
      INSERT INTO indexer_state (chain_id, last_indexed_block, updated_at)
      VALUES (${chainId}, ${block}, NOW())
      ON CONFLICT (chain_id) DO UPDATE
        SET last_indexed_block = EXCLUDED.last_indexed_block,
            updated_at = NOW()
    `;
  }

  async size(): Promise<number> {
    const rows = await this.sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM transactions
    `;
    return Number(rows[0]?.count ?? 0);
  }

  /** Close the connection pool. Call on graceful shutdown. */
  async close(): Promise<void> {
    await this.sql.end({ timeout: 5 });
  }
}
