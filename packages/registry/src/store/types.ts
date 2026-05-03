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

export interface RegistryStore {
  // Agents + claims
  upsertAgent(agentId: AgentId): Promise<void>;
  getAgent(agentId: AgentId): Promise<{ claimed_by_handle: string | null } | null>;
  startClaim(agentId: AgentId, xHandle: string): Promise<ClaimChallenge>;
  markClaimVerified(verificationHash: string): Promise<void>;

  // Listings
  upsertListing(listing: Listing): Promise<void>;
  search(req: SearchRequest): Promise<SearchResultEntry[]>;
  getListing(agentId: AgentId, capability: CapabilityId): Promise<Listing | null>;

  // Hires (written by indexer in production; insertable here for tests)
  recordHire(hire: HireRecord): Promise<void>;
  getReputation(agentId: AgentId): Promise<Reputation | null>;

  // Ratings
  consumeRatingTokenAndStore(rating: RatingRecord): Promise<void>;
  isRatingTokenUsed(token: string): Promise<boolean>;

  // Telemetry
  recordTelemetry(event: TelemetryRecord): Promise<void>;
}
