// Swarmwage Registry — Hono app factory
// License: BUSL-1.1
//
// Builds and returns a configured Hono app + the underlying store. Kept
// separate from `index.ts` so tests can spin up a fresh app without
// binding a TCP port.

import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { z } from "zod";

import { rateLimit } from "./rate-limit.js";

import {
  PROTOCOL_VERSION,
  type AgentId,
  type CapabilityId,
  type Hex,
  type Listing,
  type Stars,
} from "@swarmwage/agent-sdk";

import { MemoryStore } from "./store/memory.js";
import type { ReceiptRecord, RegistryStore } from "./store/types.js";
import { verifyTypedPayload } from "./auth.js";

export interface CreateAppOptions {
  store?: RegistryStore;
  /** When false, the HTTP request logger middleware is skipped (test noise). */
  enableRequestLogger?: boolean;
}

export interface CreatedApp {
  app: Hono;
  store: RegistryStore;
}

export function createApp(opts: CreateAppOptions = {}): CreatedApp {
  const store: RegistryStore = opts.store ?? new MemoryStore();
  const app = new Hono();

  if (opts.enableRequestLogger !== false) {
    app.use("*", logger());
  }
  app.use(
    "*",
    cors({
      origin: "*",
      allowMethods: ["GET", "POST", "OPTIONS"],
      allowHeaders: ["Content-Type", "X-Swarmwage-Protocol", "X-PAYMENT"],
    }),
  );

  // Global body size cap. Receipts + listings carry signatures and a few
  // KB of metadata; nobody legitimately needs more.
  app.use(
    "*",
    bodyLimit({
      maxSize: 64 * 1024,
      onError: (c) => c.json({ error: "Payload too large" }, 413),
    }),
  );

  // Rate limit per-IP on flood-prone unauthenticated endpoints.
  // Token bucket: 5 req/sec sustained, 30 burst. The bucket is shared
  // across all protected paths so an attacker cannot multiply their rate
  // by spreading the flood across endpoints.
  const floodGuard = rateLimit({ refillPerSec: 5, burst: 30 });
  app.use("/v1/rate", floodGuard);
  app.use("/v1/claim/*", floodGuard);
  app.use("/telemetry", floodGuard);
  // /v1/search returns up to 100 results per query — scrape protection.
  app.use("/v1/search", floodGuard);
  // /v1/listings POST runs ECDSA signature recovery (CPU); /v1/listings
  // GET is the indexer's recipient lookup. 5/sec is plenty for both.
  app.use("/v1/listings", floodGuard);
  // /v1/receipts POST runs ECDSA signature recovery on each call — same
  // CPU profile as /v1/listings POST.
  app.use("/v1/receipts", floodGuard);

  app.get("/", (c) =>
    c.json({
      name: "swarmwage-registry",
      version: "0.0.1",
      protocol: PROTOCOL_VERSION,
      repository: "https://github.com/Swarmwage/swarmwage",
    }),
  );

  app.get("/health", (c) => c.json({ status: "ok" }));

  // -----------------------------------------------------------------------
  // Search
  // -----------------------------------------------------------------------

  const SearchSchema = z.object({
    capability: z.string(),
    max_price_usdc: z.string().optional(),
    max_latency_ms: z.number().int().positive().optional(),
    min_success_rate: z.number().min(0).max(1).optional(),
    min_avg_stars: z.number().min(0).max(5).optional(),
    limit: z.number().int().min(1).max(100).optional(),
    cursor: z.string().optional(),
  });

  app.post("/v1/search", async (c) => {
    const body = await c.req.json();
    const parsed = SearchSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: "Invalid search request", issues: parsed.error.issues },
        400,
      );
    }
    const agents = await store.search(parsed.data);
    return c.json({ agents, next_cursor: null });
  });

  // -----------------------------------------------------------------------
  // Listings
  // -----------------------------------------------------------------------

  const ListingSchema = z.object({
    agent_id: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
    capability: z.string(),
    price_usdc: z.string().regex(/^\d+(\.\d+)?$/),
    currency: z.literal("USDC").default("USDC"),
    chain: z.literal("base").default("base"),
    max_latency_ms: z.number().int().positive(),
    first_call_free: z.boolean().default(false),
    endpoint: z.string().url(),
    signature: z.string().regex(/^0x[a-fA-F0-9]+$/),
  });

  app.post("/v1/listings", async (c) => {
    const body = await c.req.json();
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

    await store.upsertListing(listing);
    return c.json({ ok: true, listing });
  });

  // Recipient → agent_id resolver. Used by the indexer to map an on-chain
  // USDC `Transfer` event recipient to a known Swarmwage agent for L2 data
  // capture. Today `agent_id` IS the wallet address — the lookup is a
  // simple existence check on the agents table.
  //
  //   GET /v1/listings?recipient=0x...
  //   200 { agent_id, recipient }   — recipient is a registered agent
  //   404                           — recipient is not registered
  //   400                           — missing or malformed recipient
  app.get("/v1/listings", async (c) => {
    const recipient = c.req.query("recipient");
    if (!recipient) {
      return c.json(
        { error: "Missing required query param: recipient" },
        400,
      );
    }
    if (!/^0x[a-fA-F0-9]{40}$/.test(recipient)) {
      return c.json({ error: "Invalid recipient address" }, 400);
    }
    const normalized = recipient.toLowerCase() as AgentId;
    const agent = await store.getAgent(normalized);
    if (!agent) {
      return c.json(
        { error: "No agent registered for this recipient" },
        404,
      );
    }
    return c.json({ agent_id: normalized, recipient: normalized });
  });

  // -----------------------------------------------------------------------
  // Reputation
  // -----------------------------------------------------------------------

  app.get("/v1/agents/:id/reputation", async (c) => {
    const id = c.req.param("id").toLowerCase() as AgentId;
    if (!/^0x[a-fA-F0-9]{40}$/.test(id)) {
      return c.json({ error: "Invalid agent_id" }, 400);
    }
    const rep = await store.getReputation(id);
    if (!rep) return c.json({ error: "Agent not found" }, 404);
    return c.json(rep);
  });

  // All active listings for a seller. Read-only; no signature required.
  // Powers the `list_my_listings` MCP tool and any external dashboard.
  app.get("/v1/agents/:id/listings", async (c) => {
    const id = c.req.param("id").toLowerCase() as AgentId;
    if (!/^0x[a-fA-F0-9]{40}$/.test(id)) {
      return c.json({ error: "Invalid agent_id" }, 400);
    }
    const listings = await store.getListingsByAgent(id);
    return c.json({ agent_id: id, count: listings.length, listings });
  });

  // Recent receipts submitted by a seller. Read-only; the on-chain tx_hash
  // is already public, so this surface is too. Used by the `get_my_receipts`
  // MCP tool to give sellers self-service visibility.
  app.get("/v1/agents/:id/receipts", async (c) => {
    const id = c.req.param("id").toLowerCase() as AgentId;
    if (!/^0x[a-fA-F0-9]{40}$/.test(id)) {
      return c.json({ error: "Invalid agent_id" }, 400);
    }
    const limitRaw = c.req.query("limit");
    const limit = limitRaw ? Number(limitRaw) : undefined;
    if (limit !== undefined && (!Number.isFinite(limit) || limit < 1)) {
      return c.json({ error: "Invalid limit" }, 400);
    }
    const receipts = await store.getReceiptsByAgent(id, { limit });
    return c.json({ agent_id: id, count: receipts.length, receipts });
  });

  // -----------------------------------------------------------------------
  // Rating
  // -----------------------------------------------------------------------

  const RateSchema = z.object({
    rating_token: z.string().min(1),
    stars: z.number().int().min(1).max(5),
    latency_ms: z.number().int().positive().optional(),
    comment: z.string().max(1024).optional(),
  });

  app.post("/v1/rate", async (c) => {
    const body = await c.req.json();
    const parsed = RateSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: "Invalid rate request", issues: parsed.error.issues },
        400,
      );
    }
    const { rating_token, stars, latency_ms, comment } = parsed.data;

    if (await store.isRatingTokenUsed(rating_token)) {
      return c.json({ error: "Rating token already used" }, 409);
    }

    // In production: decode rating_token to recover (rater_id, rated_id, receipt_id).
    // v0.0.1: tokens are opaque from our perspective; the indexer issues them.
    // For dev we just store the raw record; integration with on-chain receipts
    // lands in Phase 1.4.
    await store.consumeRatingTokenAndStore({
      rating_token,
      receipt_id: rating_token,
      rater_id: "0x0000000000000000000000000000000000000000" as AgentId,
      rated_id: "0x0000000000000000000000000000000000000000" as AgentId,
      stars: stars as Stars,
      latency_ms,
      comment,
      created_at: Date.now(),
    });

    return c.json({ ok: true });
  });

  // -----------------------------------------------------------------------
  // Claim flow
  // -----------------------------------------------------------------------

  const ClaimStartSchema = z.object({
    agent_id: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
    x_handle: z.string().min(1).max(15).regex(/^[A-Za-z0-9_]+$/),
  });

  app.post("/v1/claim", async (c) => {
    const body = await c.req.json();
    const parsed = ClaimStartSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: "Invalid claim request", issues: parsed.error.issues },
        400,
      );
    }
    const challenge = await store.startClaim(
      parsed.data.agent_id.toLowerCase() as AgentId,
      parsed.data.x_handle,
    );
    return c.json({
      verification_hash: challenge.verification_hash,
      tweet_text: `Claiming agent on @swarmwage: ${challenge.agent_id} ${challenge.verification_hash}`,
      status: challenge.status,
    });
  });

  // In production: poll Twitter API server-side. v0.0.1: trust manual confirm.
  const ClaimVerifySchema = z.object({
    verification_hash: z.string().min(1),
  });
  app.post("/v1/claim/verify", async (c) => {
    const body = await c.req.json();
    const parsed = ClaimVerifySchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: "Invalid verify request", issues: parsed.error.issues },
        400,
      );
    }
    // TODO Phase 1.4: actually call Twitter API to confirm the tweet exists
    // and contains the verification hash for the claimed handle.
    await store.markClaimVerified(parsed.data.verification_hash);
    return c.json({ ok: true });
  });

  // -----------------------------------------------------------------------
  // Receipts (Layer 3 — seller-submitted)
  // -----------------------------------------------------------------------

  const ReceiptSchema = z.object({
    protocol_version: z.string().min(1),
    hire_id: z.string().min(1).max(128),
    agent_id: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
    buyer: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
    capability: z.string().min(1),
    capability_version: z.string().optional(),
    amount_usdc_atomic: z.string().regex(/^\d+$/),
    network: z.enum(["base", "base-sepolia"]),
    tx_hash: z.string().regex(/^0x[a-fA-F0-9]{64}$/),
    completed_at: z
      .string()
      .refine(
        (s) => !Number.isNaN(Date.parse(s)),
        "completed_at must be a valid ISO 8601 timestamp",
      ),
    verification: z.object({
      all_passed: z.boolean(),
      checks: z.record(z.boolean()),
    }),
    signature: z.string().regex(/^0x[a-fA-F0-9]+$/),
  });

  const RECEIPT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

  // Receipts — Layer 3 of the 4-layer data capture model.
  //
  // TRUST MODEL (v0.3, Day-7 launch posture):
  // The receipt's seller signature is verified, but the registry does NOT
  // currently cross-check `tx_hash` / `amount_usdc_atomic` against indexed
  // on-chain Transfer events. A malicious seller could submit signed
  // receipts for transactions they did not receive. This is acceptable for
  // bootstrap because reputation is a network signal — sellers caught
  // submitting fake receipts forfeit it.
  //
  // PLANNED (Phase 1.4): a reconciliation job that reads `transactions`
  // (L2, indexed) and flags receipts whose tx_hash is not present, whose
  // recipient differs from `agent_id`, or whose value mismatches
  // `amount_usdc_atomic`. Receipts so flagged are excluded from public
  // reputation aggregates. See SPEC.md §10 for the full trust model.
  app.post("/v1/receipts", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ ok: false, error: "Invalid JSON" }, 400);
    }
    const parsed = ReceiptSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { ok: false, error: "Invalid receipt", issues: parsed.error.issues },
        400,
      );
    }

    const completedAtMs = Date.parse(parsed.data.completed_at);
    const ageMs = Date.now() - completedAtMs;
    if (ageMs > RECEIPT_MAX_AGE_MS) {
      return c.json(
        { ok: false, error: "Receipt completed_at is older than 24h" },
        400,
      );
    }
    if (ageMs < -5 * 60 * 1000) {
      return c.json(
        { ok: false, error: "Receipt completed_at is in the future" },
        400,
      );
    }

    const { signature, verification, ...rest } = parsed.data;

    // Canonical payload mirrors `wallet.signTypedPayload` in @swarmwage/agent-sdk
    // and the existing `/v1/listings` verification path: alphabetical keys,
    // signature excluded.
    const canonicalPayload = {
      ...rest,
      verification,
    };

    const signerAddr = parsed.data.agent_id as `0x${string}`;
    const valid = await verifyTypedPayload(
      signerAddr,
      canonicalPayload,
      signature as Hex,
    );
    if (!valid) {
      return c.json({ ok: false, error: "Invalid signature" }, 401);
    }

    // Auto-upsert: a brand-new seller may submit their first receipt before
    // any listing has been published. The signature gate above is the
    // authoritative ownership check.
    await store.upsertAgent(signerAddr.toLowerCase() as AgentId);

    const record: ReceiptRecord = {
      protocol_version: parsed.data.protocol_version,
      hire_id: parsed.data.hire_id,
      agent_id: signerAddr.toLowerCase() as AgentId,
      buyer: parsed.data.buyer.toLowerCase() as AgentId,
      capability: parsed.data.capability as CapabilityId,
      capability_version: parsed.data.capability_version,
      amount_usdc_atomic: parsed.data.amount_usdc_atomic,
      network: parsed.data.network,
      tx_hash: parsed.data.tx_hash as `0x${string}`,
      completed_at: parsed.data.completed_at,
      verification_all_passed: verification.all_passed,
      verification_checks: verification.checks,
      signature: signature as `0x${string}`,
    };

    const result = await store.appendReceipt(record);
    if (!result.inserted) {
      return c.json(
        { ok: false, error: "duplicate_hire_id", receipt_id: result.id },
        409,
      );
    }
    return c.json({ ok: true, receipt_id: result.id });
  });

  // -----------------------------------------------------------------------
  // Telemetry
  // -----------------------------------------------------------------------

  const TelemetrySchema = z.object({
    ts: z.number().int().positive(),
    sdk_version: z.string(),
    agent_id: z
      .string()
      .regex(/^0x[a-fA-F0-9]{40}$/)
      .nullable(),
    event: z.record(z.unknown()),
  });

  app.post("/telemetry", async (c) => {
    const body = await c.req.json();
    const parsed = TelemetrySchema.safeParse(body);
    if (!parsed.success) {
      // Don't reject telemetry hard — log and 204
      return c.body(null, 204);
    }
    await store.recordTelemetry(
      parsed.data as Parameters<RegistryStore["recordTelemetry"]>[0],
    );
    return c.body(null, 204);
  });

  return { app, store };
}
