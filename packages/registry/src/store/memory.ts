// In-memory implementation of RegistryStore for development and tests.
// Production: replace with Supabase-backed implementation.
// License: BUSL-1.1

import type {
  AgentId,
  CapabilityId,
  Listing,
  Reputation,
  SearchRequest,
  SearchResultEntry,
  UsdcAmount,
} from "@swarmwage/agent-sdk";
import { randomUUID, createHash } from "node:crypto";
import type {
  ClaimChallenge,
  HireRecord,
  RatingRecord,
  ReceiptRecord,
  RegistryStore,
  TelemetryRecord,
} from "./types.js";

interface AgentRow {
  agent_id: AgentId;
  claimed_by_handle: string | null;
  claimed_at: number | null;
  created_at: number;
}

export class MemoryStore implements RegistryStore {
  private agents = new Map<AgentId, AgentRow>();
  private listings = new Map<string, Listing>(); // key: `${agentId}:${capability}`
  private hires: HireRecord[] = [];
  private ratings: RatingRecord[] = [];
  private claims = new Map<string, ClaimChallenge>(); // key: verification_hash
  private telemetry: TelemetryRecord[] = [];
  private receipts = new Map<string, { id: string; record: ReceiptRecord }>(); // key: `${hire_id}:${agent_id}`

  async upsertAgent(agentId: AgentId): Promise<void> {
    if (!this.agents.has(agentId)) {
      this.agents.set(agentId, {
        agent_id: agentId,
        claimed_by_handle: null,
        claimed_at: null,
        created_at: Date.now(),
      });
    }
  }

  async getAgent(agentId: AgentId) {
    const a = this.agents.get(agentId);
    return a ? { claimed_by_handle: a.claimed_by_handle } : null;
  }

  async startClaim(agentId: AgentId, xHandle: string): Promise<ClaimChallenge> {
    await this.upsertAgent(agentId);
    const nonce = randomUUID();
    const verification_hash = createHash("sha256")
      .update(`${agentId}:${xHandle}:${nonce}`)
      .digest("hex");
    const challenge: ClaimChallenge = {
      agent_id: agentId,
      x_handle: xHandle,
      verification_hash,
      status: "pending",
      created_at: Date.now(),
      verified_at: null,
    };
    this.claims.set(verification_hash, challenge);
    return challenge;
  }

  async markClaimVerified(verificationHash: string): Promise<void> {
    const c = this.claims.get(verificationHash);
    if (!c) return;
    c.status = "verified";
    c.verified_at = Date.now();
    const agent = this.agents.get(c.agent_id);
    if (agent) {
      agent.claimed_by_handle = c.x_handle;
      agent.claimed_at = c.verified_at;
    }
  }

  async upsertListing(listing: Listing): Promise<void> {
    await this.upsertAgent(listing.agent_id);
    this.listings.set(this.listingKey(listing.agent_id, listing.capability), listing);
  }

  async getListing(agentId: AgentId, capability: CapabilityId): Promise<Listing | null> {
    return this.listings.get(this.listingKey(agentId, capability)) ?? null;
  }

  async getListingsByAgent(agentId: AgentId): Promise<Listing[]> {
    const id = agentId.toLowerCase();
    const out: Listing[] = [];
    for (const listing of this.listings.values()) {
      if (listing.agent_id.toLowerCase() === id) out.push(listing);
    }
    return out;
  }

  async search(req: SearchRequest): Promise<SearchResultEntry[]> {
    return this.searchInternal(req, (cap) => cap === req.capability);
  }

  async searchByCapabilityPrefix(
    req: SearchRequest,
  ): Promise<SearchResultEntry[]> {
    return this.searchInternal(req, (cap) => cap.startsWith(req.capability));
  }

  async countCapabilities(): Promise<number> {
    const set = new Set<string>();
    for (const listing of this.listings.values()) {
      set.add(listing.capability);
    }
    return set.size;
  }

  /**
   * Shared search core. Applies non-capability filters identically across
   * exact + prefix variants; the only thing that varies is how the
   * capability string is matched. Keeping this in one place ensures
   * `searchByCapabilityPrefix` cannot drift away from `search`.
   */
  private async searchInternal(
    req: SearchRequest,
    capabilityMatches: (cap: string) => boolean,
  ): Promise<SearchResultEntry[]> {
    const results: SearchResultEntry[] = [];
    for (const listing of this.listings.values()) {
      if (!capabilityMatches(listing.capability)) continue;
      if (
        req.max_price_usdc !== undefined &&
        Number(listing.price_usdc) > Number(req.max_price_usdc)
      ) {
        continue;
      }
      if (
        req.max_latency_ms !== undefined &&
        listing.max_latency_ms > req.max_latency_ms
      ) {
        continue;
      }
      const rep = await this.getReputation(listing.agent_id);
      if (
        req.min_success_rate !== undefined &&
        rep &&
        rep.success_rate < req.min_success_rate
      ) {
        continue;
      }
      if (req.min_avg_stars !== undefined && rep && rep.avg_stars < req.min_avg_stars) {
        continue;
      }
      results.push({
        agent_id: listing.agent_id,
        listing: {
          capability: listing.capability,
          price_usdc: listing.price_usdc,
          currency: listing.currency,
          chain: listing.chain,
          max_latency_ms: listing.max_latency_ms,
          first_call_free: listing.first_call_free,
          endpoint: listing.endpoint,
        },
        reputation: rep
          ? {
              success_rate: rep.success_rate,
              avg_latency_ms: rep.avg_latency_ms,
              last_30d_hire_count: rep.last_30d_hire_count,
              avg_stars: rep.avg_stars,
              total_ratings: rep.total_ratings,
              claimed: rep.claimed,
            }
          : {
              success_rate: 1,
              avg_latency_ms: listing.max_latency_ms,
              last_30d_hire_count: 0,
              avg_stars: 0,
              total_ratings: 0,
              claimed: this.agents.get(listing.agent_id)?.claimed_by_handle != null,
            },
      });
    }
    // Sort: ratings desc, then price asc
    results.sort((a, b) => {
      const aScore = a.reputation.avg_stars * a.reputation.last_30d_hire_count;
      const bScore = b.reputation.avg_stars * b.reputation.last_30d_hire_count;
      if (aScore !== bScore) return bScore - aScore;
      return Number(a.listing.price_usdc) - Number(b.listing.price_usdc);
    });
    const limit = req.limit ?? 10;
    return results.slice(0, limit);
  }

  async recordHire(hire: HireRecord): Promise<void> {
    this.hires.push(hire);
  }

  async getReputation(agentId: AgentId): Promise<Reputation | null> {
    const agent = this.agents.get(agentId);
    if (!agent) return null;

    const sellerHires = this.hires.filter((h) => h.seller_id === agentId);
    const total = sellerHires.length;
    const passed = sellerHires.filter((h) => h.verification_passed).length;
    const success_rate = total === 0 ? 1 : passed / total;
    const latencies = sellerHires.map((h) => h.latency_ms ?? 0).filter((n) => n > 0);
    const avg_latency_ms =
      latencies.length === 0 ? 0 : latencies.reduce((a, b) => a + b, 0) / latencies.length;

    const now = Date.now();
    const last_24h = sellerHires.filter((h) => now - h.completed_at < 24 * 3600 * 1000);
    const last_24h_volume_usdc = last_24h
      .reduce((sum, h) => sum + Number(h.price_paid_usdc), 0)
      .toFixed(2);
    const last_30d = sellerHires.filter(
      (h) => now - h.completed_at < 30 * 24 * 3600 * 1000,
    );

    const sellerRatings = this.ratings.filter((r) => r.rated_id === agentId);
    const total_ratings = sellerRatings.length;
    const avg_stars =
      total_ratings === 0
        ? 0
        : sellerRatings.reduce((s, r) => s + r.stars, 0) / total_ratings;

    const avg_cost_per_capability: Record<CapabilityId, UsdcAmount> = {};
    const byCapability = new Map<CapabilityId, number[]>();
    for (const h of sellerHires) {
      const arr = byCapability.get(h.capability) ?? [];
      arr.push(Number(h.price_paid_usdc));
      byCapability.set(h.capability, arr);
    }
    for (const [cap, prices] of byCapability) {
      const sorted = [...prices].sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
      avg_cost_per_capability[cap] = median.toFixed(2);
    }

    return {
      agent_id: agentId,
      success_rate,
      avg_latency_ms,
      avg_cost_per_capability,
      last_24h_volume_usdc,
      last_30d_hire_count: last_30d.length,
      total_ratings,
      avg_stars,
      claimed: agent.claimed_by_handle != null,
    };
  }

  async consumeRatingTokenAndStore(rating: RatingRecord): Promise<void> {
    if (this.ratings.some((r) => r.rating_token === rating.rating_token)) {
      throw new Error("Rating token already used");
    }
    this.ratings.push(rating);
  }

  async isRatingTokenUsed(token: string): Promise<boolean> {
    return this.ratings.some((r) => r.rating_token === token);
  }

  async appendReceipt(
    receipt: ReceiptRecord,
  ): Promise<{ inserted: boolean; id: string }> {
    const key = `${receipt.hire_id}:${receipt.agent_id.toLowerCase()}`;
    const existing = this.receipts.get(key);
    if (existing) {
      return { inserted: false, id: existing.id };
    }
    const id = randomUUID();
    this.receipts.set(key, {
      id,
      record: { ...receipt, ts: Date.now() },
    });
    return { inserted: true, id };
  }

  async getReceiptsByAgent(
    agentId: AgentId,
    opts: { limit?: number } = {},
  ): Promise<Array<ReceiptRecord & { id: string }>> {
    const id = agentId.toLowerCase();
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const matches: Array<ReceiptRecord & { id: string }> = [];
    for (const { id: receiptId, record } of this.receipts.values()) {
      if (record.agent_id.toLowerCase() !== id) continue;
      matches.push({ ...record, id: receiptId });
    }
    matches.sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0));
    return matches.slice(0, limit);
  }

  async recordTelemetry(event: TelemetryRecord): Promise<void> {
    this.telemetry.push(event);
    // In production, batch + persist. For dev, keep last 10k.
    if (this.telemetry.length > 10_000) {
      this.telemetry.splice(0, this.telemetry.length - 10_000);
    }
  }

  private listingKey(agentId: AgentId, capability: CapabilityId): string {
    return `${agentId}:${capability}`;
  }
}
