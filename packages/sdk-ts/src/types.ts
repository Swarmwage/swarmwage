// Swarmwage Agent SDK — protocol types
// Spec: ../protocol/SPEC.md
// License: MIT

import { z } from "zod";

export const PROTOCOL_VERSION = "swarmwage/v0.1" as const;
export type ProtocolVersion = typeof PROTOCOL_VERSION;

// -------------------------------------------------------------------------
// Primitive aliases
// -------------------------------------------------------------------------

/** Lowercase, 0x-prefixed Ethereum-compatible address (40 hex chars). */
export type AgentId = `0x${string}`;

/** USDC amount as a human-readable decimal string, e.g. "1.50". */
export type UsdcAmount = string;

/** Hierarchical lowercase capability ID, e.g. `image.generate.photorealistic.png`. */
export type CapabilityId = string;

/** Hex string with `0x` prefix. */
export type Hex = `0x${string}`;

// -------------------------------------------------------------------------
// Listing — what a seller publishes
// -------------------------------------------------------------------------

export const ListingSchema = z.object({
  agent_id: z.string().regex(/^0x[a-fA-F0-9]{40}$/) as z.ZodType<AgentId>,
  capability: z.string(),
  price_usdc: z.string().regex(/^\d+(\.\d+)?$/),
  currency: z.literal("USDC").default("USDC"),
  chain: z.literal("base").default("base"),
  max_latency_ms: z.number().int().positive(),
  first_call_free: z.boolean().default(false),
  endpoint: z.string().url(),
  signature: z.string().regex(/^0x[a-fA-F0-9]+$/) as z.ZodType<Hex>,
});

export type Listing = z.infer<typeof ListingSchema>;

// -------------------------------------------------------------------------
// Reputation
// -------------------------------------------------------------------------

export interface Reputation {
  agent_id: AgentId;
  success_rate: number;
  avg_latency_ms: number;
  avg_cost_per_capability: Record<CapabilityId, UsdcAmount>;
  last_24h_volume_usdc: UsdcAmount;
  last_30d_hire_count: number;
  total_ratings: number;
  avg_stars: number;
  claimed: boolean;
}

// -------------------------------------------------------------------------
// Search
// -------------------------------------------------------------------------

export interface SearchRequest {
  capability: CapabilityId;
  max_price_usdc?: UsdcAmount;
  max_latency_ms?: number;
  min_success_rate?: number;
  min_avg_stars?: number;
  limit?: number;
  cursor?: string;
}

export interface SearchResultEntry {
  agent_id: AgentId;
  listing: Omit<Listing, "agent_id" | "signature">;
  reputation: Pick<
    Reputation,
    | "success_rate"
    | "avg_latency_ms"
    | "last_30d_hire_count"
    | "avg_stars"
    | "total_ratings"
    | "claimed"
  >;
}

export interface SearchResponse {
  agents: SearchResultEntry[];
  next_cursor: string | null;
  /**
   * "exact" when the registry matched on the literal capability string,
   * "prefix" when it expanded via prefix-match (e.g. `image.generate` →
   * `image.generate.photorealistic.png`). Surfaced from the registry to let
   * clients distinguish exact-hit listings from broader namespace matches.
   */
  match?: "exact" | "prefix";
  /**
   * On EMPTY results, the registry includes up to 20 live capability IDs
   * sorted alphabetically — the canonical taxonomy. Lets a calling LLM
   * recover from a wrong-ID guess on the same turn instead of hallucinating
   * a different name. OMITTED on non-empty results to keep payloads small.
   */
  available_capabilities?: string[];
  /**
   * On EMPTY results only, the total count of distinct live capabilities on
   * the registry (so callers know how much of the taxonomy is shown in
   * `available_capabilities` vs truncated by the 20-item cap).
   */
  total_distinct_capabilities?: number;
}

// -------------------------------------------------------------------------
// Budget token (operator-issued pre-authorization)
// -------------------------------------------------------------------------

export const BudgetTokenSchema = z.object({
  agent_id: z.string().regex(/^0x[a-fA-F0-9]{40}$/) as z.ZodType<AgentId>,
  max_amount_usdc: z.string().regex(/^\d+(\.\d+)?$/),
  max_duration_seconds: z.number().int().positive(),
  issued_at: z.number().int().positive(),
  signature: z.string().regex(/^0x[a-fA-F0-9]+$/) as z.ZodType<Hex>,
});

export type BudgetToken = z.infer<typeof BudgetTokenSchema>;

// -------------------------------------------------------------------------
// Hire flow
// -------------------------------------------------------------------------

export interface HireRequest {
  /** Target seller agent. If omitted, SDK picks the best match. */
  agent_id?: AgentId;
  /** Seller endpoint. If omitted, SDK resolves via search. */
  endpoint?: string;
  capability: CapabilityId;
  params: Record<string, unknown>;
  max_price_usdc: UsdcAmount;
  max_latency_ms?: number;
  budget_token?: BudgetToken;
  /** If provided, an async hire is opened with this callback URL. */
  callback_url?: string;
  /** Optional idempotency key. SDK generates one if omitted. */
  nonce?: string;
  /**
   * Validate that the seller's x402 challenge demands payment to the address
   * matching the resolved `agent_id`. Defaults to `true`. Set `false` ONLY
   * for trusted local testing or when you knowingly accept paying a
   * different address than the listing claims (e.g. an operator restart).
   *
   * When `true` and the buyer cannot determine an `agent_id` (because
   * `endpoint` was provided without one), `hire()` throws before sending.
   */
  validateSeller?: boolean;
}

export interface VerificationCheck {
  name: string;
  passed: boolean;
  detail?: string;
}

export interface VerificationResult {
  checks: VerificationCheck[];
  all_passed: boolean;
}

export interface Receipt {
  receipt_id: string;
  buyer_id: AgentId;
  seller_id: AgentId;
  capability: CapabilityId;
  tx_hash: Hex;
  price_paid_usdc: UsdcAmount;
  completed_at: number; // unix seconds
}

export interface HireResponse {
  protocol: ProtocolVersion;
  receipt: Receipt;
  result: Record<string, unknown>;
  verification: VerificationResult;
  rating_token: string;
}

export interface AsyncHireResponse {
  protocol: ProtocolVersion;
  job_id: string;
  estimated_completion_ms: number;
}

export type JobStatus =
  | { status: "pending"; job_id: string; estimated_completion_ms: number }
  | { status: "complete"; job_id: string; response: HireResponse }
  | { status: "failed"; job_id: string; error: string };

// -------------------------------------------------------------------------
// Raw x402 call — pay any external x402 endpoint, outside the Swarmwage hire
// envelope. Lets a buyer call third-party x402 services (e.g. a public x402
// catalog) directly: the SDK handles the 402 payment dance but sends the
// service's own native request shape and returns its raw response. There is
// no Swarmwage seller-identity check — the price cap is the safety bound.
// -------------------------------------------------------------------------

export interface PayX402Request {
  /** Absolute URL of the x402-enabled endpoint to call. */
  url: string;
  /** HTTP method. Defaults to "POST" when `body` is set, else "GET". */
  method?: string;
  /** JSON request body in the service's native shape (NOT a Swarmwage envelope). */
  body?: unknown;
  /** Extra request headers merged onto the request. */
  headers?: Record<string, string>;
  /**
   * Optional attribution metadata for third-party x402 catalogs. This is
   * telemetry-only: it does not affect payment signing, settlement, or the
   * request sent to the external service.
   */
  source?: string;
  service_id?: string;
  service_name?: string;
  endpoint_description?: string;
  category?: string;
  pricing_scheme?: string;
  /**
   * Willingness-to-pay cap in USDC (decimal string, e.g. "0.05"). The SDK
   * refuses to sign a payment exceeding this. Defaults to "1.00".
   */
  max_price_usdc?: UsdcAmount;
}

export interface PayX402Response {
  /** The URL that was called. */
  url: string;
  /** HTTP status of the final (post-payment) response. */
  status: number;
  /** The service's raw response body (parsed as JSON). */
  data: unknown;
  /** x402 settlement transaction hash, when the endpoint reported one. */
  tx_hash?: Hex;
  /** Amount paid in USDC, from the selected 402 requirement. Omitted when no payment was required. */
  amount_paid_usdc?: UsdcAmount;
  /** Registry id for the client-observed external reliability record, when submitted. */
  reliability_record_id?: string;
  /** SHA-256 hash of the JSON request body, when a body was sent. */
  request_hash?: Hex;
  /** SHA-256 hash of the parsed JSON response body. */
  response_hash?: Hex;
  /** End-to-end latency in milliseconds. */
  latency_ms: number;
}

export interface ExternalX402ReliabilityQuery {
  /** Max aggregate rows to return. Registry default 50, max 200. */
  limit?: number;
  /** Attribution source such as `agentic.market`. */
  source?: string;
  /** Optional external catalog service id. */
  service_id?: string;
  /** Exact endpoint URL. */
  url?: string;
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

export interface ExternalX402ReliabilityResponse {
  trust_level: "client_observed";
  count: number;
  services: ExternalX402ServiceReliability[];
  note: string;
}

// -------------------------------------------------------------------------
// Rating
// -------------------------------------------------------------------------

export type Stars = 1 | 2 | 3 | 4 | 5;

// -------------------------------------------------------------------------
// Seller-submitted receipts (Layer 3 of the 4-layer data capture)
// -------------------------------------------------------------------------

/**
 * A receipt as stored on the registry after the seller signs and submits it.
 * Returned by `client.getMyReceipts()` and `GET /v1/agents/:id/receipts`.
 * Shape mirrors the registry's `ReceiptRecord` plus the assigned `id`.
 */
export interface SubmittedReceipt {
  id: string;
  protocol_version: string;
  hire_id: string;
  agent_id: AgentId;
  buyer: AgentId;
  capability: CapabilityId;
  capability_version?: string;
  amount_usdc_atomic: string;
  network: "base" | "base-sepolia";
  tx_hash: Hex;
  completed_at: string;
  verification_all_passed: boolean;
  verification_checks: Record<string, boolean>;
  signature: Hex;
  ts?: number;
}

export interface RatingRequest {
  rating_token: string;
  stars: Stars;
  latency_ms?: number;
  comment?: string;
}
