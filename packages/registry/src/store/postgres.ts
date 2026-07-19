// Postgres-backed implementation of RegistryStore.
// License: BUSL-1.1
//
// Reads/writes the schema in `packages/registry/schema.sql` via the
// postgres-js driver. The implementation matches the semantics of
// `MemoryStore` exactly, so request handlers in `app.ts` work
// unchanged when this store is wired in at boot.

import postgres from "postgres";
import { randomUUID, createHash } from "node:crypto";
import type {
  AgentId,
  CapabilityId,
  Listing,
  Reputation,
  SearchRequest,
  SearchResultEntry,
  Stars,
  UsdcAmount,
} from "@swarmwage/agent-sdk";

import type {
  ClaimChallenge,
  ExternalX402ReliabilityRecord,
  ExternalX402ServiceReliability,
  HireRecord,
  RatingRecord,
  ReceiptRecord,
  RegistryStore,
  TelemetryRecord,
} from "./types.js";
import { aggregateExternalX402Group } from "./external-x402-aggregate.js";

// Register the `bigint` type so values stored as TEXT atomic-USDC
// (TEXT in this schema, but bigint elsewhere) round-trip without loss.
type Sql = postgres.Sql<{ bigint: bigint }>;

export interface PostgresStoreOptions {
  /** Postgres connection string. Pooler URL recommended for serverless. */
  connectionString: string;
  /** Max pool connections. Defaults to 5 — Supabase Transaction pooler safe. */
  max?: number;
}

interface ListingRow {
  agent_id: string;
  payee: string | null;
  capability: string;
  price_usdc: string;
  currency: string;
  chain: string;
  max_latency_ms: number;
  first_call_free: boolean;
  endpoint: string;
  signature: string;
}

interface ReputationRow {
  agent_id: string;
  claimed: boolean;
  success_rate: number;
  avg_latency_ms: number;
  last_30d_hire_count: number;
  last_24h_volume_usdc: string;
  total_ratings: number;
  avg_stars: number;
}

export class PostgresStore implements RegistryStore {
  // Mutable so the health watchdog can swap in a fresh pool when the live
  // one wedges (see startWatchdog). All query methods read `this.sql` at
  // call time, so a swap transparently routes new queries to the new pool.
  private sql: Sql;
  private readonly opts: PostgresStoreOptions;
  private watchdog?: ReturnType<typeof setInterval>;
  private consecutiveProbeFailures = 0;
  private rebuilding = false;

  constructor(opts: PostgresStoreOptions) {
    this.opts = opts;
    this.sql = this.buildPool();
    this.startWatchdog();
  }

  private buildPool(): Sql {
    return postgres(this.opts.connectionString, {
      max: this.opts.max ?? 5,
      prepare: false,
      types: { bigint: postgres.BigInt },
      // Pool resilience. Without these, postgres-js keeps connections open
      // forever; when Supabase's pgbouncer recycles an idle server-side
      // connection the client doesn't notice the dead socket, so the next
      // query on it hangs indefinitely. With max:5 it takes only 5 such
      // wedged connections to make every DB-backed endpoint time out while
      // /health (no DB) still answers — exactly the outage seen 2026-05-26.
      //   idle_timeout  — proactively close idle conns before pgbouncer does
      //   max_lifetime  — recycle every conn well inside the pooler's window
      //   connect_timeout — fail fast on connect instead of hanging a request
      idle_timeout: 30,
      max_lifetime: 60 * 30,
      connect_timeout: 10,
      // Server-side ceiling on a single query. Catches a slow-but-alive
      // backend (lock wait, runaway scan) and returns an error that frees
      // the connection back to the pool. NOTE: this alone does NOT rescue
      // the wedge case below — a recycled/half-open backend never executes
      // the query, so statement_timeout never fires. That's the watchdog's
      // job.
      connection: { statement_timeout: 15000 },
    });
  }

  // The idle_timeout/max_lifetime knobs above only reclaim connections that
  // are *idle* or *connecting*. A connection wedged mid-query against the
  // Supabase transaction pooler (pooler recycles the server-side backend,
  // socket goes half-open, no response ever arrives, no client-side query
  // timeout) is *busy* — it never returns to the pool, so those knobs never
  // touch it. Five such wedges exhaust max:5 and every DB route hangs while
  // /health stays green (outage seen 2026-05-26 AND 2026-05-27).
  //
  // The watchdog is what actually recovers: it probes `SELECT 1` on a short
  // race; if the pool can't answer twice in a row it rebuilds the pool. The
  // old pool's `end({ timeout })` force-closes the wedged sockets, which
  // rejects their hung queries (failing those HTTP requests fast) while all
  // new queries flow to the fresh, healthy pool. Self-heals in ~20-35s with
  // no manual restart.
  private startWatchdog(): void {
    const PROBE_INTERVAL_MS = 10_000;
    const PROBE_TIMEOUT_MS = 5_000;
    const FAILURES_BEFORE_REBUILD = 2;

    this.watchdog = setInterval(async () => {
      if (this.rebuilding) return;
      const ok = await this.probe(PROBE_TIMEOUT_MS);
      if (ok) {
        this.consecutiveProbeFailures = 0;
        return;
      }
      this.consecutiveProbeFailures += 1;
      if (this.consecutiveProbeFailures >= FAILURES_BEFORE_REBUILD) {
        this.rebuildPool();
      }
    }, PROBE_INTERVAL_MS);
    // Don't keep the event loop alive on account of the watchdog.
    this.watchdog.unref?.();
  }

  /**
   * Run `SELECT 1` but never hang on it: if the pool can't answer within
   * `timeoutMs` (all connections wedged, so the probe can't even check one
   * out) the race rejects and we report unhealthy. The abandoned probe is
   * harmless — it gets force-closed when the pool is rebuilt.
   */
  private async probe(timeoutMs: number): Promise<boolean> {
    const query = this.sql`SELECT 1`;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("db probe timeout")), timeoutMs);
    });
    try {
      await Promise.race([query, timeout]);
      return true;
    } catch {
      try {
        (query as { cancel?: () => void }).cancel?.();
      } catch {
        /* best-effort */
      }
      return false;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private rebuildPool(): void {
    if (this.rebuilding) return;
    this.rebuilding = true;
    const old = this.sql;
    this.sql = this.buildPool();
    this.consecutiveProbeFailures = 0;
    console.error(
      "[registry] DB pool unresponsive — rebuilt connection pool to recover from wedged connections",
    );
    // Force-close the old pool. timeout:5 lets in-flight queries that CAN
    // finish do so; the rest are dropped (their awaiters reject), which is
    // exactly what unsticks the wedge.
    void old
      .end({ timeout: 5 })
      .catch(() => {})
      .finally(() => {
        this.rebuilding = false;
      });
  }

  // -------------------------------------------------------------------
  // Agents + claims
  // -------------------------------------------------------------------

  async upsertAgent(agentId: AgentId): Promise<void> {
    const id = agentId.toLowerCase();
    await this.sql`
      INSERT INTO agents (agent_id) VALUES (${id})
      ON CONFLICT (agent_id) DO NOTHING
    `;
  }

  async getAgent(
    agentId: AgentId,
  ): Promise<{ claimed_by_handle: string | null } | null> {
    const id = agentId.toLowerCase();
    const rows = await this.sql<{ claimed_by_handle: string | null }[]>`
      SELECT claimed_by_handle FROM agents WHERE agent_id = ${id}
    `;
    return rows[0] ?? null;
  }

  async startClaim(agentId: AgentId, xHandle: string): Promise<ClaimChallenge> {
    const id = agentId.toLowerCase() as AgentId;
    await this.upsertAgent(id);
    const nonce = randomUUID();
    const verification_hash = createHash("sha256")
      .update(`${id}:${xHandle}:${nonce}`)
      .digest("hex");
    const created_at = Date.now();
    await this.sql`
      INSERT INTO claims (agent_id, x_handle, verification_hash, status)
      VALUES (${id}, ${xHandle}, ${verification_hash}, 'pending')
    `;
    return {
      agent_id: id,
      x_handle: xHandle,
      verification_hash,
      status: "pending",
      created_at,
      verified_at: null,
    };
  }

  async markClaimVerified(verificationHash: string): Promise<void> {
    // Atomically flip the claim and update the agent's claimed_by_handle.
    // We do this in a transaction so the agents row never reflects a
    // verified claim that the claims row hasn't recorded yet.
    await this.sql.begin(async (tx) => {
      const rows = await tx<{ agent_id: string; x_handle: string }[]>`
        UPDATE claims
           SET status = 'verified',
               verified_at = NOW()
         WHERE verification_hash = ${verificationHash}
           AND status = 'pending'
         RETURNING agent_id, x_handle
      `;
      const row = rows[0];
      if (!row) return;
      await tx`
        UPDATE agents
           SET claimed_by_handle = ${row.x_handle},
               claimed_at = NOW()
         WHERE agent_id = ${row.agent_id}
      `;
    });
  }

  // -------------------------------------------------------------------
  // Listings
  // -------------------------------------------------------------------

  async upsertListing(listing: Listing): Promise<void> {
    const agent_id = listing.agent_id.toLowerCase();
    await this.upsertAgent(agent_id as AgentId);
    await this.sql`
      INSERT INTO listings (
        agent_id, payee, capability, price_usdc, currency, chain,
        max_latency_ms, first_call_free, endpoint, signature, active
      ) VALUES (
        ${agent_id},
        ${listing.payee?.toLowerCase() ?? null},
        ${listing.capability},
        ${listing.price_usdc},
        ${listing.currency},
        ${listing.chain},
        ${listing.max_latency_ms},
        ${listing.first_call_free},
        ${listing.endpoint},
        ${listing.signature},
        TRUE
      )
      ON CONFLICT (agent_id, capability) DO UPDATE
        SET payee = EXCLUDED.payee,
            price_usdc = EXCLUDED.price_usdc,
            currency = EXCLUDED.currency,
            chain = EXCLUDED.chain,
            max_latency_ms = EXCLUDED.max_latency_ms,
            first_call_free = EXCLUDED.first_call_free,
            endpoint = EXCLUDED.endpoint,
            signature = EXCLUDED.signature,
            active = TRUE,
            updated_at = NOW()
    `;
  }

  async getAgentIdByPayee(payee: string): Promise<AgentId | null> {
    const needle = payee.toLowerCase();
    // Publishing is free, so a second agent could claim a victim's payee to
    // siphon their on-chain attribution. Refuse ambiguity: more than one
    // distinct claimant ⇒ null (no attribution) rather than first-writer-wins.
    const rows = await this.sql<{ agent_id: string }[]>`
      SELECT DISTINCT agent_id FROM listings
      WHERE payee = ${needle} AND active
      LIMIT 2
    `;
    if (rows.length !== 1) return null;
    return (rows[0]?.agent_id as AgentId) ?? null;
  }

  async getListing(
    agentId: AgentId,
    capability: CapabilityId,
  ): Promise<Listing | null> {
    const id = agentId.toLowerCase();
    const rows = await this.sql<ListingRow[]>`
      SELECT agent_id, payee, capability, price_usdc, currency, chain,
             max_latency_ms, first_call_free, endpoint, signature
      FROM listings
      WHERE agent_id = ${id} AND capability = ${capability} AND active
      LIMIT 1
    `;
    const row = rows[0];
    if (!row) return null;
    return rowToListing(row);
  }

  async getListingsByAgent(agentId: AgentId): Promise<Listing[]> {
    const id = agentId.toLowerCase();
    const rows = await this.sql<ListingRow[]>`
      SELECT agent_id, payee, capability, price_usdc, currency, chain,
             max_latency_ms, first_call_free, endpoint, signature
      FROM listings
      WHERE agent_id = ${id} AND active
      ORDER BY capability ASC
    `;
    return rows.map(rowToListing);
  }

  async search(req: SearchRequest): Promise<SearchResultEntry[]> {
    return this.searchInternal(req, "exact");
  }

  async searchByCapabilityPrefix(
    req: SearchRequest,
  ): Promise<SearchResultEntry[]> {
    return this.searchInternal(req, "prefix");
  }

  async countCapabilities(): Promise<number> {
    const rows = await this.sql<{ count: string }[]>`
      SELECT COUNT(DISTINCT capability)::text AS count
      FROM listings
      WHERE active
    `;
    return Number(rows[0]?.count ?? 0);
  }

  async listActiveCapabilities(limit: number): Promise<string[]> {
    const rows = await this.sql<{ capability: string }[]>`
      SELECT DISTINCT capability
      FROM listings
      WHERE active
      ORDER BY capability ASC
      LIMIT ${limit}
    `;
    return rows.map((r) => r.capability);
  }

  /**
   * Shared search core. Capability match swaps between `=` and `LIKE prefix%`
   * based on the `mode` flag; all other filters are identical so the two
   * variants cannot drift apart.
   */
  private async searchInternal(
    req: SearchRequest,
    mode: "exact" | "prefix",
  ): Promise<SearchResultEntry[]> {
    // Single round-trip: listings JOIN reputation view, with the
    // protocol filters applied in SQL. Ranking order (matches MemoryStore):
    //   1. listings with any rating come first (squat-protection: a fresh
    //      unclaimed listing cannot leapfrog a proven agent on price alone)
    //   2. within rated, by avg_stars * last_30d_hire_count DESC
    //   3. tie-break on l.created_at ASC — oldest listing first, so seed
    //      agents present since Day 7 outrank a same-day price-cut squat
    //   4. final tie-break on price ASC (relevant only inside the same
    //      reputation + first-seen bucket)
    const limit = req.limit ?? 10;
    const maxPrice =
      req.max_price_usdc !== undefined ? Number(req.max_price_usdc) : null;
    const maxLatency = req.max_latency_ms ?? null;
    const minSuccess = req.min_success_rate ?? null;
    const minStars = req.min_avg_stars ?? null;
    // Escape LIKE wildcards (`%`, `_`, `\`) so a capability like
    // `foo_bar` isn't interpreted as a wildcard pattern. ESCAPE clause
    // below picks up the literal backslash.
    const prefixPattern =
      req.capability.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_") +
      "%";

    const rows = await this.sql<(ListingRow & ReputationRow)[]>`
      SELECT
        l.agent_id, l.payee, l.capability, l.price_usdc, l.currency, l.chain,
        l.max_latency_ms, l.first_call_free, l.endpoint, l.signature,
        r.claimed,
        r.success_rate,
        r.avg_latency_ms,
        r.last_30d_hire_count,
        r.last_24h_volume_usdc,
        r.total_ratings,
        r.avg_stars
      FROM listings l
      JOIN reputation r ON r.agent_id = l.agent_id
      WHERE l.active
        AND (
          (${mode} = 'exact'  AND l.capability = ${req.capability})
          OR
          (${mode} = 'prefix' AND l.capability LIKE ${prefixPattern} ESCAPE '\\')
        )
        AND (${maxPrice}::numeric IS NULL OR l.price_usdc::numeric <= ${maxPrice}::numeric)
        AND (${maxLatency}::integer IS NULL OR l.max_latency_ms <= ${maxLatency}::integer)
        AND (${minSuccess}::float IS NULL OR r.success_rate >= ${minSuccess}::float)
        AND (${minStars}::float IS NULL OR r.avg_stars >= ${minStars}::float)
      ORDER BY (CASE WHEN COALESCE(r.total_ratings, 0) > 0 THEN 1 ELSE 0 END) DESC,
               (COALESCE(r.avg_stars, 0) * COALESCE(r.last_30d_hire_count, 0)) DESC,
               l.created_at ASC,
               l.price_usdc::numeric ASC
      LIMIT ${limit}
    `;

    return rows.map((row) => ({
      agent_id: row.agent_id as AgentId,
      listing: {
        capability: row.capability as CapabilityId,
        price_usdc: row.price_usdc as UsdcAmount,
        currency: row.currency as "USDC",
        chain: row.chain as "base",
        max_latency_ms: row.max_latency_ms,
        first_call_free: row.first_call_free,
        endpoint: row.endpoint,
        ...(row.payee ? { payee: row.payee as AgentId } : {}),
      },
      reputation: {
        success_rate: Number(row.success_rate),
        avg_latency_ms: Number(row.avg_latency_ms),
        last_30d_hire_count: Number(row.last_30d_hire_count),
        avg_stars: Number(row.avg_stars),
        total_ratings: Number(row.total_ratings),
        claimed: row.claimed,
      },
    }));
  }

  // -------------------------------------------------------------------
  // Hires + reputation
  // -------------------------------------------------------------------

  async recordHire(hire: HireRecord): Promise<void> {
    const seller = hire.seller_id.toLowerCase();
    const buyer = hire.buyer_id.toLowerCase();
    await this.upsertAgent(seller as AgentId);
    await this.sql`
      INSERT INTO hires (
        receipt_id, buyer_id, seller_id, capability, tx_hash,
        price_paid_usdc, verification_passed, latency_ms, completed_at
      ) VALUES (
        ${hire.receipt_id},
        ${buyer},
        ${seller},
        ${hire.capability},
        ${hire.tx_hash},
        ${hire.price_paid_usdc},
        ${hire.verification_passed},
        ${hire.latency_ms ?? null},
        to_timestamp(${hire.completed_at}::double precision / 1000)
      )
      ON CONFLICT (receipt_id) DO NOTHING
    `;
  }

  async getReputation(agentId: AgentId): Promise<Reputation | null> {
    const id = agentId.toLowerCase();
    const repRows = await this.sql<ReputationRow[]>`
      SELECT agent_id, claimed, success_rate, avg_latency_ms,
             last_30d_hire_count, last_24h_volume_usdc,
             total_ratings, avg_stars
      FROM reputation
      WHERE agent_id = ${id}
      LIMIT 1
    `;
    const rep = repRows[0];
    if (!rep) return null;

    // Median price per capability (the field is named `avg_*` for back-
    // compat but the in-memory store also returns the median — keep
    // semantics identical so call-sites don't shift).
    const costRows = await this.sql<
      { capability: string; median_price: string }[]
    >`
      SELECT capability,
             percentile_cont(0.5) WITHIN GROUP (
               ORDER BY price_paid_usdc::numeric
             )::text AS median_price
      FROM hires
      WHERE seller_id = ${id}
      GROUP BY capability
    `;
    const avg_cost_per_capability: Record<CapabilityId, UsdcAmount> = {};
    for (const c of costRows) {
      const median = Number(c.median_price);
      avg_cost_per_capability[c.capability as CapabilityId] = median.toFixed(
        2,
      ) as UsdcAmount;
    }

    return {
      agent_id: id as AgentId,
      success_rate: Number(rep.success_rate),
      avg_latency_ms: Number(rep.avg_latency_ms),
      avg_cost_per_capability,
      last_24h_volume_usdc: rep.last_24h_volume_usdc as UsdcAmount,
      last_30d_hire_count: Number(rep.last_30d_hire_count),
      total_ratings: Number(rep.total_ratings),
      avg_stars: Number(rep.avg_stars),
      claimed: rep.claimed,
    };
  }

  // Recompute the materialized `reputation` view. CONCURRENTLY does not
  // block readers (relies on reputation_agent_id_idx). The matview is
  // created WITH DATA, so the first concurrent refresh is valid.
  // ponytail: process-driven setInterval, fine at single-replica; move to
  // pg_cron if we ever run >1 registry replica.
  async refreshReputation(): Promise<void> {
    try {
      await this.sql`REFRESH MATERIALIZED VIEW CONCURRENTLY reputation`;
    } catch (err) {
      // 42809 = `reputation` is still a plain VIEW (migration 003 not applied
      // yet). A VIEW is always live, so there is nothing to refresh — return
      // quietly instead of spamming stderr every interval. Apply the migration
      // to get the materialized (scale-safe) path.
      if ((err as { code?: string } | null)?.code === "42809") return;
      throw err;
    }
  }

  // -------------------------------------------------------------------
  // Receipts (Layer 3 of the 4-layer data capture)
  // -------------------------------------------------------------------

  async appendReceipt(
    receipt: ReceiptRecord,
  ): Promise<{ inserted: boolean; id: string }> {
    const seller = receipt.agent_id.toLowerCase();
    const buyer = receipt.buyer.toLowerCase();
    // Try to insert — if (hire_id, agent_id) already exists, fetch the
    // existing id and report `inserted: false`. Two round-trips on
    // duplicate; one on the happy path.
    const inserted = await this.sql<{ id: string }[]>`
      INSERT INTO receipts (
        protocol_version, hire_id, agent_id, payee, buyer, capability,
        capability_version, amount_usdc_atomic, network, tx_hash,
        completed_at, verification_all_passed, verification_checks,
        signature
      ) VALUES (
        ${receipt.protocol_version},
        ${receipt.hire_id},
        ${seller},
        ${receipt.payee?.toLowerCase() ?? null},
        ${buyer},
        ${receipt.capability},
        ${receipt.capability_version ?? null},
        ${receipt.amount_usdc_atomic},
        ${receipt.network},
        ${receipt.tx_hash},
        ${receipt.completed_at}::timestamptz,
        ${receipt.verification_all_passed},
        ${this.sql.json(receipt.verification_checks as never)},
        ${receipt.signature}
      )
      ON CONFLICT (hire_id, agent_id) DO NOTHING
      RETURNING id
    `;
    if (inserted[0]) return { inserted: true, id: inserted[0].id };

    const existing = await this.sql<{ id: string }[]>`
      SELECT id FROM receipts
      WHERE hire_id = ${receipt.hire_id} AND agent_id = ${seller}
      LIMIT 1
    `;
    if (!existing[0]) {
      // Race: deleted between the insert and the lookup. Surface as a
      // duplicate (caller treats this as 409) — alternative would be to
      // re-insert, but we'd rather fail closed.
      throw new Error(
        "Receipt insert returned 0 rows but no existing row found",
      );
    }
    return { inserted: false, id: existing[0].id };
  }

  async getReceiptsByAgent(
    agentId: AgentId,
    opts: { limit?: number } = {},
  ): Promise<Array<ReceiptRecord & { id: string }>> {
    const id = agentId.toLowerCase();
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const rows = await this.sql<
      Array<{
        id: string;
        protocol_version: string;
        hire_id: string;
        agent_id: string;
        payee: string | null;
        buyer: string;
        capability: string;
        capability_version: string | null;
        amount_usdc_atomic: string;
        network: "base" | "base-sepolia";
        tx_hash: string;
        completed_at: Date;
        verification_all_passed: boolean;
        verification_checks: Record<string, boolean>;
        signature: string;
        ts: Date;
      }>
    >`
      SELECT id, protocol_version, hire_id, agent_id, payee, buyer, capability,
             capability_version, amount_usdc_atomic, network, tx_hash,
             completed_at, verification_all_passed, verification_checks,
             signature, ts
      FROM receipts
      WHERE agent_id = ${id}
      ORDER BY ts DESC
      LIMIT ${limit}
    `;
    return rows.map((row) => ({
      id: row.id,
      protocol_version: row.protocol_version,
      hire_id: row.hire_id,
      agent_id: row.agent_id as AgentId,
      ...(row.payee ? { payee: row.payee as AgentId } : {}),
      buyer: row.buyer as AgentId,
      capability: row.capability as CapabilityId,
      capability_version: row.capability_version ?? undefined,
      amount_usdc_atomic: row.amount_usdc_atomic,
      network: row.network,
      tx_hash: row.tx_hash as `0x${string}`,
      completed_at: row.completed_at.toISOString(),
      verification_all_passed: row.verification_all_passed,
      verification_checks: row.verification_checks,
      signature: row.signature as `0x${string}`,
      ts: row.ts.getTime(),
    }));
  }

  // -------------------------------------------------------------------
  // Ratings
  // -------------------------------------------------------------------

  async consumeRatingTokenAndStore(rating: RatingRecord): Promise<void> {
    try {
      await this.sql`
        INSERT INTO ratings (
          rating_token, receipt_id, rater_id, rated_id,
          stars, latency_ms, comment
        ) VALUES (
          ${rating.rating_token},
          ${rating.receipt_id},
          ${rating.rater_id.toLowerCase()},
          ${rating.rated_id.toLowerCase()},
          ${rating.stars as Stars},
          ${rating.latency_ms ?? null},
          ${rating.comment ?? null}
        )
      `;
    } catch (err) {
      // 23505 = unique_violation — translate to the same error message
      // the in-memory store throws so call-sites work unchanged.
      if (
        err instanceof Error &&
        "code" in err &&
        (err as { code: string }).code === "23505"
      ) {
        throw new Error("Rating token already used");
      }
      throw err;
    }
  }

  async isRatingTokenUsed(token: string): Promise<boolean> {
    const rows = await this.sql<{ exists: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM ratings WHERE rating_token = ${token}
      ) AS exists
    `;
    return rows[0]?.exists ?? false;
  }

  // -------------------------------------------------------------------
  // Telemetry
  // -------------------------------------------------------------------

  async recordTelemetry(event: TelemetryRecord): Promise<void> {
    await this.sql`
      INSERT INTO telemetry_events (ts, sdk_version, agent_id, event)
      VALUES (
        to_timestamp(${event.ts}::double precision / 1000),
        ${event.sdk_version},
        ${event.agent_id ? event.agent_id.toLowerCase() : null},
        ${this.sql.json(event.event as never)}
      )
    `;
  }

  async appendExternalX402ReliabilityRecord(
    record: ExternalX402ReliabilityRecord,
  ): Promise<{ id: string }> {
    const inserted = await this.sql<{ id: string }[]>`
      INSERT INTO external_x402_reliability_records (
        ts, trust_level, buyer_agent_id, source, service_id, service_name,
        category, endpoint_description, pricing_scheme, url, method, status,
        amount_paid_usdc, tx_hash, latency_ms, request_hash, response_hash,
        verifier_kind, verifier_status, verifier_checks, error
      ) VALUES (
        to_timestamp(${record.ts}::double precision / 1000),
        ${record.trust_level},
        ${record.buyer_agent_id ? record.buyer_agent_id.toLowerCase() : null},
        ${record.source ?? null},
        ${record.service_id ?? null},
        ${record.service_name ?? null},
        ${record.category ?? null},
        ${record.endpoint_description ?? null},
        ${record.pricing_scheme ?? null},
        ${record.url},
        ${record.method},
        ${record.status},
        ${record.amount_paid_usdc ?? null},
        ${record.tx_hash ?? null},
        ${record.latency_ms},
        ${record.request_hash ?? null},
        ${record.response_hash},
        ${record.verifier_kind},
        ${record.verifier_status},
        ${this.sql.json(record.verifier_checks as never)},
        ${record.error ?? null}
      )
      RETURNING id
    `;
    return { id: inserted[0]?.id ?? "" };
  }

  async listExternalX402ServiceReliability(
    opts: {
      limit?: number;
      source?: string;
      service_id?: string;
      url?: string;
    } = {},
  ): Promise<ExternalX402ServiceReliability[]> {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const source = opts.source ?? null;
    const serviceId = opts.service_id ?? null;
    const url = opts.url ?? null;
    const rows = await this.sql<
      Array<{
        id: string;
        ts: Date;
        trust_level: "client_observed";
        buyer_agent_id: string | null;
        source: string | null;
        service_id: string | null;
        service_name: string | null;
        category: string | null;
        endpoint_description: string | null;
        pricing_scheme: string | null;
        url: string;
        method: string;
        status: number;
        amount_paid_usdc: string | null;
        tx_hash: string | null;
        latency_ms: number;
        request_hash: string | null;
        response_hash: string;
        verifier_kind: "none" | "json" | "custom";
        verifier_status: "unknown" | "pass" | "fail";
        verifier_checks: Record<string, boolean>;
        error: string | null;
      }>
    >`
      SELECT id, ts, trust_level, buyer_agent_id, source, service_id,
             service_name, category, endpoint_description, pricing_scheme,
             url, method, status, amount_paid_usdc, tx_hash, latency_ms,
             request_hash, response_hash, verifier_kind, verifier_status,
             verifier_checks, error
      FROM external_x402_reliability_records
      WHERE (${source}::text IS NULL OR source = ${source})
        AND (${serviceId}::text IS NULL OR service_id = ${serviceId})
        AND (${url}::text IS NULL OR url = ${url})
      ORDER BY ts DESC
      LIMIT ${limit * 100}
    `;

    const groups = new Map<
      string,
      Array<ExternalX402ReliabilityRecord & { id: string }>
    >();
    for (const row of rows) {
      const record: ExternalX402ReliabilityRecord & { id: string } = {
        id: row.id,
        ts: row.ts.getTime(),
        trust_level: row.trust_level,
        buyer_agent_id: row.buyer_agent_id as AgentId | null,
        source: row.source ?? undefined,
        service_id: row.service_id ?? undefined,
        service_name: row.service_name ?? undefined,
        category: row.category ?? undefined,
        endpoint_description: row.endpoint_description ?? undefined,
        pricing_scheme: row.pricing_scheme ?? undefined,
        url: row.url,
        method: row.method,
        status: row.status,
        amount_paid_usdc: row.amount_paid_usdc ?? undefined,
        tx_hash: row.tx_hash as `0x${string}` | undefined,
        latency_ms: row.latency_ms,
        request_hash: row.request_hash as `0x${string}` | undefined,
        response_hash: row.response_hash as `0x${string}`,
        verifier_kind: row.verifier_kind,
        verifier_status: row.verifier_status,
        verifier_checks: row.verifier_checks,
        error: row.error ?? undefined,
      };
      const key = `${record.source ?? ""}:${record.service_id ?? ""}:${record.method}:${record.url}`;
      const group = groups.get(key) ?? [];
      group.push(record);
      groups.set(key, group);
    }

    return Array.from(groups.values())
      .map(aggregateExternalX402Group)
      .sort((a, b) => b.last_call_ts - a.last_call_ts)
      .slice(0, limit);
  }

  /** Close the connection pool. Call on graceful shutdown. */
  async close(): Promise<void> {
    if (this.watchdog) clearInterval(this.watchdog);
    await this.sql.end({ timeout: 5 });
  }
}

function rowToListing(row: ListingRow): Listing {
  return {
    agent_id: row.agent_id as AgentId,
    ...(row.payee ? { payee: row.payee as AgentId } : {}),
    capability: row.capability as CapabilityId,
    price_usdc: row.price_usdc as UsdcAmount,
    currency: row.currency as "USDC",
    chain: row.chain as "base",
    max_latency_ms: row.max_latency_ms,
    first_call_free: row.first_call_free,
    endpoint: row.endpoint,
    signature: row.signature as `0x${string}`,
  };
}
