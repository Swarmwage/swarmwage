// Swarmwage Registry — POST /v1/listings (publish) + GET /v1/listings (lookup)
// License: BUSL-1.1

import type { Context } from "hono";
import { z } from "zod";

import type { AgentId, Listing } from "@swarmwage/agent-sdk";

import type { RegistryStore } from "../store/types.js";
import { verifyTypedPayload } from "../auth.js";
import { blockedEndpointReason } from "../endpoint-policy.js";
import { challengeEndpointOwnership } from "../endpoint-verify.js";
import { invalidJsonResponse, readJsonBody } from "../http.js";

const ListingSchema = z.object({
  agent_id: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  // Optional split of payment recipient from seller identity (GH #11): the
  // runtime holds only the identity/signing key, revenue lands on `payee`.
  // Covered by the listing signature like every other field — tampering
  // invalidates it. Absent ⇒ payments go to agent_id (legacy single-EOA).
  payee: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/)
    .optional(),
  // ASCII-only lowercase taxonomy. Rejects empty strings, Unicode
  // homoglyphs (e.g. Cyrillic `і` U+0456 squatting on Latin `image…`),
  // and uppercase or whitespace garbage that would fragment the namespace.
  capability: z
    .string()
    .min(3)
    .max(128)
    .regex(/^[a-z][a-z0-9._-]*$/),
  // USDC on-chain has 6 decimal places, so anything past the 6th digit
  // would be silently rounded by the token contract — a seller listing
  // 0.0000001 USDC would settle 0 on-chain. Also forbid zero: listings
  // priced at 0 are perma-free spam (use `first_call_free` for the
  // legitimate first-call-free affordance, on top of a non-zero price).
  price_usdc: z
    .string()
    .regex(/^\d+(\.\d{1,6})?$/, "price has at most 6 decimal places (USDC precision)")
    .refine((v) => parseFloat(v) > 0, {
      message: "price must be > 0; use first_call_free for free-tier",
    }),
  currency: z.literal("USDC").default("USDC"),
  chain: z.literal("base").default("base"),
  // Bounded latency advertisement. Lower bound rejects ranking-gaming
  // (a seller cannot advertise `1` to look fastest in search). Upper
  // bound stops Postgres integer overflow on absurd values like
  // 999999999999999 (PG `integer` is signed 32-bit, max ~2.1e9) which
  // would crash the listings INSERT with HTTP 500.
  max_latency_ms: z.number().int().min(100).max(60000),
  first_call_free: z.boolean().default(false),
  // HTTPS-only + no SSRF. Plain http:// would let an in-path attacker
  // intercept EIP-3009 payment authorization headers; endpoints pointing
  // at loopback / private / cloud-metadata addresses would let a malicious
  // seller proxy buyer-side SSRF attacks (see blockedEndpointReason).
  endpoint: z
    .string()
    .url()
    .refine((u) => u.startsWith("https://"), {
      message: "endpoint must use HTTPS",
    })
    .refine((u) => blockedEndpointReason(u) === null, {
      message: "endpoint hostname is loopback, private, or cloud-metadata",
    }),
  signature: z.string().regex(/^0x[a-fA-F0-9]+$/),
});

// Per-agent_id publish rate limit. The IP-based floodGuard middleware
// already caps overall publish throughput; this catches the attacker who
// rotates IPs but cannot cheaply rotate agent_ids. 10 publishes per minute
// per agent_id is generous — a legit seller restarts at most a few times a
// day.
//
// The token is consumed AFTER signature verification, not before: consuming
// on any well-formed body would let an unauthenticated attacker exhaust a
// victim seller's bucket with garbage-signature publishes (griefing). The
// CPU cost of signature recovery on unauthenticated floods is bounded by
// the per-IP floodGuard upstream — an attacker rotating agent_ids would
// land in a fresh bucket anyway, so pre-verify consumption never bought
// CPU protection against the rotating attacker.
const PUBLISH_BURST_PER_AGENT = 10;
const PUBLISH_REFILL_PER_SEC = 10 / 60; // 1 token every 6 s

interface PublishBucket {
  tokens: number;
  updatedAt: number;
}

export class PublishRateLimiter {
  private readonly buckets = new Map<string, PublishBucket>();
  private requestsSinceGc = 0;

  consume(agentId: string): { ok: boolean; retryAfter: number } {
    const now = Date.now();
    this.maybeGc(now);
    const key = agentId.toLowerCase();
    const cur = this.buckets.get(key) ?? {
      tokens: PUBLISH_BURST_PER_AGENT,
      updatedAt: now,
    };
    const elapsed = (now - cur.updatedAt) / 1000;
    cur.tokens = Math.min(
      PUBLISH_BURST_PER_AGENT,
      cur.tokens + elapsed * PUBLISH_REFILL_PER_SEC,
    );
    cur.updatedAt = now;
    if (cur.tokens < 1) {
      this.buckets.set(key, cur);
      return {
        ok: false,
        retryAfter: Math.ceil((1 - cur.tokens) / PUBLISH_REFILL_PER_SEC),
      };
    }
    cur.tokens -= 1;
    this.buckets.set(key, cur);
    return { ok: true, retryAfter: 0 };
  }

  /** Number of live buckets — exposed for the eviction regression test. */
  size(): number {
    return this.buckets.size;
  }

  // Lazy GC, same pattern as the IP rate limiter: every 1024 consumes,
  // drop buckets idle for >10 minutes. A bucket refills completely in 60s,
  // so anything idle that long is indistinguishable from a fresh one —
  // keeping it would only grow the map unboundedly (one entry per agent_id
  // ever seen).
  private maybeGc(now: number): void {
    if (++this.requestsSinceGc % 1024 !== 0) return;
    const cutoff = now - 10 * 60 * 1000;
    for (const [k, b] of this.buckets) {
      if (b.updatedAt < cutoff) this.buckets.delete(k);
    }
  }
}

export interface PublishListingDeps {
  store: RegistryStore;
  publishLimiter: PublishRateLimiter;
  /** Endpoint ownership proof mode (Wave 2a). See env.ts for semantics. */
  endpointVerifyMode: "off" | "soft" | "enforce";
  endpointVerifyTimeoutMs: number;
  endpointVerifyOverrides?: {
    fetchFn?: typeof fetch;
    nonceFn?: () => string;
  };
}

export function createPublishListingHandler(deps: PublishListingDeps) {
  const {
    store,
    publishLimiter,
    endpointVerifyMode,
    endpointVerifyTimeoutMs,
    endpointVerifyOverrides,
  } = deps;

  return async (c: Context): Promise<Response> => {
    const body = await readJsonBody(c);
    if (body === undefined) return invalidJsonResponse(c);
    const parsed = ListingSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: "Invalid listing", issues: parsed.error.issues },
        400,
      );
    }
    const listing = parsed.data as Listing;

    // Verify signature
    const { signature, ...payload } = listing;
    const valid = await verifyTypedPayload(listing.agent_id, payload, signature);
    if (!valid) {
      return c.json({ error: "Invalid signature" }, 401);
    }

    // Per-agent_id rate limit — applied only to signature-valid publishes
    // (see PublishRateLimiter comment), and BEFORE the endpoint ownership
    // challenge, which is the expensive outbound-HTTP step.
    const gate = publishLimiter.consume(listing.agent_id);
    if (!gate.ok) {
      c.header("Retry-After", String(gate.retryAfter));
      return c.json(
        {
          error: "Publish rate limit exceeded for this agent_id",
          retry_after_seconds: gate.retryAfter,
        },
        429,
      );
    }

    // Endpoint ownership proof (Wave 2a). The listing signature above proves
    // the publisher controls `agent_id`. This challenge proves the entity
    // running `endpoint` also controls `agent_id` — i.e., they are the same
    // operator. Closes the squat where a third-party endpoint is bound to
    // a wallet that does not actually run it.
    if (endpointVerifyMode !== "off") {
      const result = await challengeEndpointOwnership(
        listing.endpoint,
        listing.agent_id,
        {
          timeoutMs: endpointVerifyTimeoutMs,
          fetchFn: endpointVerifyOverrides?.fetchFn,
          nonceFn: endpointVerifyOverrides?.nonceFn,
        },
      );
      if (!result.ok) {
        const msg = `endpoint ownership proof failed: ${result.reason}`;
        if (endpointVerifyMode === "enforce") {
          return c.json({ error: msg }, 400);
        }
        // soft mode: log and continue
        process.stderr.write(
          `swarmwage-registry: WARN ${listing.agent_id} ${listing.capability} ${msg}\n`,
        );
      }
    }

    await store.upsertListing(listing);
    return c.json({ ok: true, listing });
  };
}

export interface ListingsLookupDeps {
  store: RegistryStore;
  /** The machine-discoverable index payload served when no query is given. */
  indexPayload: (capabilityCount: number) => Record<string, unknown>;
}

// Recipient → agent_id resolver. Used by the indexer to map an on-chain
// USDC `Transfer` event recipient to a known Swarmwage agent for L2 data
// capture. For legacy sellers `agent_id` IS the wallet address (existence
// check on the agents table); payee-split sellers (GH #11) are resolved
// through the `payee` declared in their active listings, so on-chain volume
// landing on the payee still attributes to the publishing agent.
//
//   GET /v1/listings?recipient=0x...
//   200 { agent_id, recipient }   — recipient is a registered agent or a
//                                   listing payee (agent_id = the publisher)
//   404                           — recipient is not registered
//   400                           — missing or malformed recipient
export function createListingsLookupHandler(deps: ListingsLookupDeps) {
  const { store, indexPayload } = deps;
  return async (c: Context): Promise<Response> => {
    const recipient = c.req.query("recipient");
    // No query params at all: return a documented index instead of 400.
    // Visitors who curl the bare endpoint discover the route surface,
    // example `POST /v1/search` invocation, and how many distinct
    // capabilities the registry currently indexes.
    if (!recipient) {
      const capability_count = await store.countCapabilities();
      return c.json(indexPayload(capability_count));
    }
    if (!/^0x[a-fA-F0-9]{40}$/.test(recipient)) {
      return c.json({ error: "Invalid recipient address" }, 400);
    }
    const normalized = recipient.toLowerCase() as AgentId;
    const agent = await store.getAgent(normalized);
    if (agent) {
      return c.json({ agent_id: normalized, recipient: normalized });
    }
    const payeeOwner = await store.getAgentIdByPayee(normalized);
    if (payeeOwner) {
      return c.json({ agent_id: payeeOwner, recipient: normalized });
    }
    return c.json({ error: "No agent registered for this recipient" }, 404);
  };
}
