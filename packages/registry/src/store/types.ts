// Registry store interface — async to make swapping in Supabase trivial.
// License: BUSL-1.1

import type {
  AgentId,
  CapabilityId,
  Listing,
  Reputation,
  SearchRequest,
  SearchResultEntry,
  Stars,
} from "@swarmwage/agent-sdk";

export interface ClaimChallenge {
  agent_id: AgentId;
  x_handle: string;
  verification_hash: string;
  status: "pending" | "verified" | "failed";
  created_at: number;
  verified_at: number | null;
}

export interface HireRecord {
  receipt_id: string;
  buyer_id: AgentId;
  seller_id: AgentId;
  capability: CapabilityId;
  tx_hash: `0x${string}`;
  price_paid_usdc: string;
  verification_passed: boolean;
  latency_ms?: number;
  completed_at: number;
}

export interface RatingRecord {
  rating_token: string;
  receipt_id: string;
  rater_id: AgentId;
  rated_id: AgentId;
  stars: Stars;
  latency_ms?: number;
  comment?: string;
  created_at: number;
}

export interface TelemetryRecord {
  ts: number;
  sdk_version: string;
  agent_id: AgentId | null;
  event: Record<string, unknown>;
}

export interface ExternalX402ReliabilityRecord {
  id?: string;
  ts: number;
  trust_level: "client_observed";
  buyer_agent_id: AgentId | null;
  source?: string;
  service_id?: string;
  service_name?: string;
  category?: string;
  endpoint_description?: string;
  pricing_scheme?: string;
  url: string;
  method: string;
  status: number;
  amount_paid_usdc?: string;
  tx_hash?: `0x${string}`;
  latency_ms: number;
  request_hash?: `0x${string}`;
  response_hash: `0x${string}`;
  verifier_kind: "none" | "json" | "custom";
  verifier_status: "unknown" | "pass" | "fail";
  verifier_checks: Record<string, boolean>;
  error?: string;
}

export interface ExternalX402ServiceReliability {
  trust_level: "client_observed";
  source?: string;
  service_id?: string;
  service_name?: string;
  category?: string;
  endpoint_description?: string;
  pricing_scheme?: string;
  url: string;
  method: string;
  calls: number;
  paid_calls: number;
  success_rate: number;
  final_status_counts: Record<string, number>;
  latency_ms: {
    p50: number | null;
    p95: number | null;
  };
  last_call_ts: number;
  verifier_counts: Record<"unknown" | "pass" | "fail", number>;
  tx_hash_coverage: number;
}

/**
 * Seller-submitted receipt — Layer 3 of the 4-layer data capture model.
 *
 * The seller signs a canonical JSON of the payload (every field except
 * `signature`, keys sorted) using the same scheme as listings, then POSTs
 * to `/v1/receipts`. The registry verifies the signature recovers to
 * `agent_id` (the seller) before persisting.
 */
export interface ReceiptRecord {
  protocol_version: string;
  /** Idempotency key: SDK-generated UUID per hire attempt. */
  hire_id: string;
  /** Seller (recipient of payment) — the signer. */
  agent_id: AgentId;
  /** Buyer address (informational). */
  buyer: AgentId;
  capability: CapabilityId;
  capability_version?: string;
  /** USDC amount in atomic units (6 decimals), as a string for BigInt safety. */
  amount_usdc_atomic: string;
  network: "base" | "base-sepolia";
  tx_hash: `0x${string}`;
  /** ISO 8601 timestamp when the seller observed completion. */
  completed_at: string;
  verification_all_passed: boolean;
  verification_checks: Record<string, boolean>;
  /** 0x-prefixed signature over the canonical payload (no `signature` key). */
  signature: `0x${string}`;
  /** Server-side received_at, populated by the store on append. */
  ts?: number;
}

export interface RegistryStore {
  // Agents + claims
  upsertAgent(agentId: AgentId): Promise<void>;
  getAgent(agentId: AgentId): Promise<{ claimed_by_handle: string | null } | null>;
  startClaim(agentId: AgentId, xHandle: string): Promise<ClaimChallenge>;
  markClaimVerified(verificationHash: string): Promise<void>;

  // Listings
  upsertListing(listing: Listing): Promise<void>;
  search(req: SearchRequest): Promise<SearchResultEntry[]>;
  /**
   * Prefix-match variant of `search`: returns all active listings whose
   * `capability` starts with `req.capability`. All other filter fields
   * (`max_price_usdc`, `max_latency_ms`, `min_success_rate`, `min_avg_stars`,
   * `limit`) apply identically. Used by `POST /v1/search` when the request
   * carries `match: "prefix"`.
   */
  searchByCapabilityPrefix(req: SearchRequest): Promise<SearchResultEntry[]>;
  getListing(agentId: AgentId, capability: CapabilityId): Promise<Listing | null>;
  /** All listings for a single seller (read-only, no signature required). */
  getListingsByAgent(agentId: AgentId): Promise<Listing[]>;
  /**
   * Count of distinct `capability` strings across active listings. Powers
   * the `GET /v1/listings` documentation index so callers see how rich the
   * catalogue currently is.
   */
  countCapabilities(): Promise<number>;
  /**
   * Distinct `capability` strings across active listings, lexicographically
   * sorted, capped at `limit`. Powers the `available_capabilities` hint that
   * `POST /v1/search` returns when a query yields zero matches — so callers
   * (SDK, MCP, agents) can suggest a valid capability instead of failing
   * silently.
   */
  listActiveCapabilities(limit: number): Promise<string[]>;

  // Hires (written by indexer in production; insertable here for tests)
  recordHire(hire: HireRecord): Promise<void>;
  getReputation(agentId: AgentId): Promise<Reputation | null>;

  // Receipts (Layer 3 — seller-submitted)
  /**
   * Persist a verified receipt. Idempotent on (hire_id, agent_id):
   * returns `{ inserted: true, id }` on first call, `{ inserted: false, id }`
   * on duplicate.
   */
  appendReceipt(
    receipt: ReceiptRecord,
  ): Promise<{ inserted: boolean; id: string }>;
  /**
   * Receipts submitted by a given seller, most recent first. Read-only
   * surface for the `get_my_receipts` MCP tool and the `/v1/agents/:id/receipts`
   * endpoint. `limit` defaults to 50, capped at 200 by callers.
   */
  getReceiptsByAgent(
    agentId: AgentId,
    opts?: { limit?: number },
  ): Promise<Array<ReceiptRecord & { id: string }>>;

  // Ratings
  consumeRatingTokenAndStore(rating: RatingRecord): Promise<void>;
  isRatingTokenUsed(token: string): Promise<boolean>;

  // Telemetry
  recordTelemetry(event: TelemetryRecord): Promise<void>;

  // External x402 reliability (buyer/client-observed)
  appendExternalX402ReliabilityRecord(
    record: ExternalX402ReliabilityRecord,
  ): Promise<{ id: string }>;
  listExternalX402ServiceReliability(opts?: {
    limit?: number;
    source?: string;
    service_id?: string;
    url?: string;
  }): Promise<ExternalX402ServiceReliability[]>;

  // Recompute the materialized `reputation` view. Optional: only the
  // Postgres store materializes reputation (the memory store computes it
  // on read). Called on an interval by the server process.
  refreshReputation?(): Promise<void>;
}
