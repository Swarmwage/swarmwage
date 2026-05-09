// Swarmwage Facilitator — log store interface + implementations
// License: BUSL-1.1
//
// The store records every `/verify` and `/settle` interaction. Two
// implementations are provided: `InMemoryStore` for development and the
// smoke tests, and `PostgresStore` for production deployments. Both
// satisfy `FacilitatorLogStore` and are interchangeable at the boot
// boundary based on the presence of `DATABASE_URL`.

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

/**
 * Safe coercion of a user-supplied numeric string to BigInt. Accepts
 * decimal (`"123"`) and 0x-prefixed hex (`"0x7b"`); returns 0n for any
 * other shape so a malformed amount cannot crash a log write. Distinct
 * from relay.ts's safeBigInt which returns null — here we always need a
 * concrete BigInt to satisfy the schema, and 0n with `ok: false` already
 * carried in the log row is a fine sentinel for a corrupted entry.
 */
function safeBigInt(value: string): bigint {
  if (/^0x[0-9a-fA-F]+$/.test(value)) {
    try {
      return BigInt(value);
    } catch {
      return 0n;
    }
  }
  if (/^\d+$/.test(value)) {
    try {
      return BigInt(value);
    } catch {
      return 0n;
    }
  }
  return 0n;
}

// ---------------------------------------------------------------------------
// PostgresStore
// ---------------------------------------------------------------------------

import postgres from "postgres";
// Register the `bigint` type so atomic USDC amounts and gas-wei values
// (which routinely exceed `Number.MAX_SAFE_INTEGER`) round-trip safely.
type Sql = postgres.Sql<{ bigint: bigint }>;

export interface PostgresStoreOptions {
  /** Postgres connection string. Pooler URL recommended for serverless. */
  connectionString: string;
  /** Max pool connections. Defaults to 5 — Supabase Transaction pooler safe. */
  max?: number;
  /** Optional logger to surface non-fatal write errors. */
  onError?: (err: unknown) => void;
}

/**
 * Postgres-backed implementation of `FacilitatorLogStore`. Writes are
 * synchronous (the caller awaits commit) so log loss is bounded by the
 * database SLA rather than by process lifetime. If you need non-blocking
 * writes for tail-latency reasons, wrap this with an in-memory buffer +
 * flush worker — keep this implementation honest first.
 *
 * Schema: `packages/facilitator/schema.sql`.
 */
export class PostgresStore implements FacilitatorLogStore {
  private readonly sql: Sql;
  private readonly onError: (err: unknown) => void;

  constructor(opts: PostgresStoreOptions) {
    this.sql = postgres(opts.connectionString, {
      max: opts.max ?? 5,
      // Connection pooler (PgBouncer) is incompatible with prepared statements.
      // Disable the prepared-statement cache so we work seamlessly behind
      // Supavisor's transaction-mode pooler on port 6543.
      prepare: false,
      // Postgres BIGINT → JS string (avoid silent precision loss). The
      // facilitator log uses bigint for atomic-USDC amounts and gas-wei,
      // both of which can exceed Number.MAX_SAFE_INTEGER.
      types: {
        bigint: postgres.BigInt,
      },
    });
    this.onError = opts.onError ?? (() => undefined);
  }

  async appendLog(entry: FacilitatorLogEntry): Promise<void> {
    // Coerce user-controlled string amounts to BigInt safely. The buyer
    // can put anything into `auth.value` (or the seller into
    // `paymentRequirements.maxAmountRequired`); a non-numeric string would
    // make the bare `BigInt(...)` constructor throw a SyntaxError before
    // the SQL is even queued. Without the coercion, the throw would escape
    // appendLog and — under the previous fire-and-forget call sites — get
    // silently swallowed, leaving a hole in the logs that downstream
    // analytics would never notice.
    const amountAtomic = safeBigInt(entry.amount_usdc_atomic);
    const gasWei =
      entry.gas_eth_spent_wei !== null
        ? safeBigInt(entry.gas_eth_spent_wei)
        : null;

    try {
      await this.sql`
        INSERT INTO facilitator_logs (
          ts, route, network, agent_id, capability,
          payer_address, recipient_address, amount_usdc_atomic,
          tx_hash, gas_eth_spent_wei, latency_ms,
          ok, error, raw_request, raw_response
        ) VALUES (
          to_timestamp(${entry.ts}::double precision / 1000),
          ${entry.route},
          ${entry.network},
          ${entry.agent_id},
          ${entry.capability},
          ${entry.payer_address},
          ${entry.recipient_address},
          ${amountAtomic},
          ${entry.tx_hash},
          ${gasWei},
          ${entry.latency_ms},
          ${entry.ok},
          ${entry.error},
          ${this.sql.json(entry.raw_request as never)},
          ${this.sql.json(entry.raw_response as never)}
        )
      `;
    } catch (err) {
      this.onError(err);
      throw err;
    }
  }

  async size(): Promise<number> {
    const rows = await this.sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM facilitator_logs
    `;
    return Number(rows[0]?.count ?? 0);
  }

  /** Close the connection pool. Call on graceful shutdown. */
  async close(): Promise<void> {
    await this.sql.end({ timeout: 5 });
  }
}
