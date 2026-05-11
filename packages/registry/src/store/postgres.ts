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
  HireRecord,
  RatingRecord,
  ReceiptRecord,
  RegistryStore,
  TelemetryRecord,
} from "./types.js";

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
  private readonly sql: Sql;

  constructor(opts: PostgresStoreOptions) {
    this.sql = postgres(opts.connectionString, {
      max: opts.max ?? 5,
      prepare: false,
      types: { bigint: postgres.BigInt },
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
        agent_id, capability, price_usdc, currency, chain,
        max_latency_ms, first_call_free, endpoint, signature, active
      ) VALUES (
        ${agent_id},
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
        SET price_usdc = EXCLUDED.price_usdc,
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

  async getListing(
    agentId: AgentId,
    capability: CapabilityId,
  ): Promise<Listing | null> {
    const id = agentId.toLowerCase();
    const rows = await this.sql<ListingRow[]>`
      SELECT agent_id, capability, price_usdc, currency, chain,
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
      SELECT agent_id, capability, price_usdc, currency, chain,
             max_latency_ms, first_call_free, endpoint, signature
      FROM listings
      WHERE agent_id = ${id} AND active
      ORDER BY capability ASC
    `;
    return rows.map(rowToListing);
  }

  async search(req: SearchRequest): Promise<SearchResultEntry[]> {
    // Single round-trip: listings JOIN reputation view, with the
    // protocol filters applied in SQL. Sorts the same way the in-memory
    // store does: avg_stars * last_30d_hire_count DESC, price ASC.
    const limit = req.limit ?? 10;
    const maxPrice =
      req.max_price_usdc !== undefined ? Number(req.max_price_usdc) : null;
    const maxLatency = req.max_latency_ms ?? null;
    const minSuccess = req.min_success_rate ?? null;
    const minStars = req.min_avg_stars ?? null;

    const rows = await this.sql<(ListingRow & ReputationRow)[]>`
      SELECT
        l.agent_id, l.capability, l.price_usdc, l.currency, l.chain,
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
        AND l.capability = ${req.capability}
        AND (${maxPrice}::numeric IS NULL OR l.price_usdc::numeric <= ${maxPrice}::numeric)
        AND (${maxLatency}::integer IS NULL OR l.max_latency_ms <= ${maxLatency}::integer)
        AND (${minSuccess}::float IS NULL OR r.success_rate >= ${minSuccess}::float)
        AND (${minStars}::float IS NULL OR r.avg_stars >= ${minStars}::float)
      ORDER BY (r.avg_stars * r.last_30d_hire_count) DESC,
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
        protocol_version, hire_id, agent_id, buyer, capability,
        capability_version, amount_usdc_atomic, network, tx_hash,
        completed_at, verification_all_passed, verification_checks,
        signature
      ) VALUES (
        ${receipt.protocol_version},
        ${receipt.hire_id},
        ${seller},
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
      SELECT id, protocol_version, hire_id, agent_id, buyer, capability,
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

  /** Close the connection pool. Call on graceful shutdown. */
  async close(): Promise<void> {
    await this.sql.end({ timeout: 5 });
  }
}

function rowToListing(row: ListingRow): Listing {
  return {
    agent_id: row.agent_id as AgentId,
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
