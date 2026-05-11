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
import { WebhookDispatcher } from "./webhooks.js";

/**
 * Returns a non-null human-readable reason when the given endpoint URL points
 * to a host the registry must NOT accept as a public seller endpoint, or null
 * when the URL passes. Closes the SSRF surface a malicious seller would
 * otherwise have by publishing a listing whose endpoint is a loopback /
 * private / cloud-metadata address — the moment a buyer hires that listing,
 * the buyer SDK fetches the URL from inside the buyer's network and exposes
 * services (IMDS credentials, internal admin panels) that only the buyer
 * itself can reach. We block at publish-time so the listing never appears in
 * search results.
 */
function blockedEndpointReason(endpoint: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    return "endpoint is not a valid URL";
  }
  if (parsed.username !== "" || parsed.password !== "") {
    return "endpoint must not contain userinfo (user:pass@host)";
  }
  const raw = parsed.hostname.toLowerCase();
  // IPv6 hostnames arrive bracketed in `URL.hostname` — strip for matching.
  const host =
    raw.startsWith("[") && raw.endsWith("]") ? raw.slice(1, -1) : raw;
  if (
    host === "localhost" ||
    host === "localhost.localdomain" ||
    host === "ip6-localhost" ||
    host === "ip6-loopback" ||
    host === "::1" ||
    host === "0.0.0.0"
  ) {
    return "endpoint hostname is loopback / localhost";
  }
  if (
    host === "metadata.google.internal" ||
    host === "metadata.azure.com" ||
    host === "instance-data" ||
    host === "instance-data.ec2.internal" ||
    host.endsWith(".internal")
  ) {
    return "endpoint hostname is a known cloud metadata service";
  }
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const a = Number(ipv4[1]);
    const b = Number(ipv4[2]);
    if ([a, b, Number(ipv4[3]), Number(ipv4[4])].some((n) => n < 0 || n > 255)) {
      return "endpoint IP literal is malformed";
    }
    // 10.0.0.0/8 private
    if (a === 10) return "endpoint IP is in private range 10.0.0.0/8";
    // 172.16.0.0/12 private
    if (a === 172 && b >= 16 && b <= 31)
      return "endpoint IP is in private range 172.16.0.0/12";
    // 192.168.0.0/16 private
    if (a === 192 && b === 168)
      return "endpoint IP is in private range 192.168.0.0/16";
    // 127.0.0.0/8 loopback
    if (a === 127) return "endpoint IP is loopback (127.0.0.0/8)";
    // 169.254.0.0/16 link-local — AWS/GCP/Azure IMDS lives here
    if (a === 169 && b === 254)
      return "endpoint IP is link-local (169.254.0.0/16) — cloud metadata";
    // 0.0.0.0/8 "this network", multicast, class E reserved
    if (a === 0) return "endpoint IP is in 0.0.0.0/8";
    if (a >= 224) return "endpoint IP is multicast or reserved (>=224.0.0.0)";
  }
  // IPv6 ULA fc00::/7 + link-local fe80::/10 (lowercase already)
  if (/^f[cd][0-9a-f]{0,2}:/.test(host)) {
    return "endpoint IPv6 is in ULA range fc00::/7";
  }
  if (host.startsWith("fe80:") || host.startsWith("fe90:") || host.startsWith("fea0:") || host.startsWith("feb0:")) {
    return "endpoint IPv6 is link-local fe80::/10";
  }
  return null;
}

export interface CreateAppOptions {
  store?: RegistryStore;
  /** When false, the HTTP request logger middleware is skipped (test noise). */
  enableRequestLogger?: boolean;
  /** Outbound webhook dispatcher. When omitted, no webhooks are fired. */
  webhookDispatcher?: WebhookDispatcher;
}

export interface CreatedApp {
  app: Hono;
  store: RegistryStore;
  webhookDispatcher: WebhookDispatcher | undefined;
}

export function createApp(opts: CreateAppOptions = {}): CreatedApp {
  const store: RegistryStore = opts.store ?? new MemoryStore();
  const webhookDispatcher = opts.webhookDispatcher;
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

  // Public endpoints surfaced on the root index. Keep this in sync with the
  // routes registered below — it doubles as both human documentation for
  // anyone who hits the URL in a browser AND a machine-discoverable manifest
  // for agents that want to introspect the registry without scraping docs.
  const PUBLIC_ROUTES = [
    { method: "GET", path: "/", description: "this index" },
    { method: "GET", path: "/health", description: "liveness probe" },
    {
      method: "POST",
      path: "/v1/search",
      description:
        "Search active listings by capability. Body: { capability, match?: 'exact'|'prefix', max_price_usdc?, max_latency_ms?, min_success_rate?, min_avg_stars?, limit? }",
    },
    {
      method: "GET",
      path: "/v1/listings",
      description:
        "Recipient → agent_id lookup when ?recipient=0x... is supplied. With no query param, returns this index.",
    },
    {
      method: "POST",
      path: "/v1/listings",
      description: "Publish a signed listing.",
    },
    {
      method: "GET",
      path: "/v1/agents/:id/listings",
      description: "All active listings for a seller.",
    },
    {
      method: "GET",
      path: "/v1/agents/:id/receipts",
      description: "Recent receipts submitted by a seller.",
    },
    {
      method: "GET",
      path: "/v1/agents/:id/reputation",
      description: "Aggregate reputation for an agent.",
    },
    {
      method: "POST",
      path: "/v1/receipts",
      description: "Submit a seller-signed receipt (Layer 3 data capture).",
    },
    {
      method: "POST",
      path: "/v1/rate",
      description: "Consume a rating token and record stars + comment.",
    },
    {
      method: "POST",
      path: "/v1/claim",
      description: "Begin a tweet-based agent identity claim.",
    },
    {
      method: "POST",
      path: "/v1/claim/verify",
      description: "Finalise a tweet-based claim by verification hash.",
    },
  ] as const;
  const SPEC_URL =
    "https://github.com/Swarmwage/swarmwage/blob/main/packages/protocol/SPEC.md";

  app.get("/", (c) =>
    c.json({
      name: "swarmwage-registry",
      version: "0.0.1",
      protocol: PROTOCOL_VERSION,
      repository: "https://github.com/Swarmwage/swarmwage",
      docs: SPEC_URL,
      routes: PUBLIC_ROUTES,
    }),
  );

  app.get("/health", (c) => c.json({ status: "ok" }));

  // -----------------------------------------------------------------------
  // Search
  // -----------------------------------------------------------------------

  const SearchSchema = z.object({
    capability: z.string().min(1),
    // `match` controls how the capability string is interpreted.
    // - "exact"  (default): listings.capability === req.capability.
    // - "prefix": listings.capability startsWith req.capability. Useful for
    //   marketed shorthand like `audio.transcribe` (matches the canonical
    //   `audio.transcribe.json-with-timestamps`).
    // Default kept as "exact" for backwards compatibility with existing
    // SDK / MCP / facilitator callers.
    match: z.enum(["exact", "prefix"]).optional().default("exact"),
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
    const { match, ...searchReq } = parsed.data;
    const agents =
      match === "prefix"
        ? await store.searchByCapabilityPrefix(searchReq)
        : await store.search(searchReq);
    return c.json({ agents, next_cursor: null, match });
  });

  // -----------------------------------------------------------------------
  // Listings
  // -----------------------------------------------------------------------

  const ListingSchema = z.object({
    agent_id: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
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
    max_latency_ms: z.number().int().positive(),
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
    // No query params at all: return a documented index instead of 400.
    // Visitors who curl the bare endpoint discover the route surface,
    // example `POST /v1/search` invocation, and how many distinct
    // capabilities the registry currently indexes.
    if (!recipient) {
      const capability_count = await store.countCapabilities();
      return c.json({
        name: "swarmwage-registry",
        endpoint: "/v1/listings",
        description:
          "GET this endpoint with ?recipient=0x... to resolve a payment recipient to an agent_id. POST to publish a signed listing. To search the active catalogue, POST /v1/search instead.",
        capability_count,
        routes: PUBLIC_ROUTES,
        docs: SPEC_URL,
        examples: {
          search_exact: {
            method: "POST",
            url: "/v1/search",
            curl: "curl -X POST https://api.swarmwage.com/v1/search -H 'Content-Type: application/json' -d '{\"capability\":\"audio.transcribe.json-with-timestamps\"}'",
          },
          search_prefix: {
            method: "POST",
            url: "/v1/search",
            curl: "curl -X POST https://api.swarmwage.com/v1/search -H 'Content-Type: application/json' -d '{\"capability\":\"audio.transcribe\",\"match\":\"prefix\"}'",
          },
          recipient_lookup: {
            method: "GET",
            url: "/v1/listings?recipient=0xabc...123",
            curl: "curl https://api.swarmwage.com/v1/listings?recipient=0xabc...123",
          },
        },
      });
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

    // Self-hire / wash-trading block: a seller may not submit a receipt
    // claiming they served themselves. Otherwise a single wallet could
    // inflate its own last_30d_hire_count and reputation by hiring itself
    // (transferWithAuthorization buyer→seller with the same address is a
    // no-op on the USDC contract — zero economic cost, full reputation gain).
    if (
      parsed.data.agent_id.toLowerCase() === parsed.data.buyer.toLowerCase()
    ) {
      return c.json(
        {
          ok: false,
          error: "Self-hire is not allowed: buyer and agent_id must differ",
        },
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

    // Notify configured webhook receivers. Fire-and-forget — the receipt
    // submitter does not wait on receiver latency, and receiver failures
    // do not propagate. Receivers verify integrity via X-Webhook-Signature.
    if (webhookDispatcher?.enabled()) {
      webhookDispatcher.fire({
        event: "receipt.created",
        receipt_id: result.id,
        protocol_version: record.protocol_version,
        hire_id: record.hire_id,
        agent_id: record.agent_id,
        buyer: record.buyer,
        capability: record.capability,
        capability_version: record.capability_version,
        amount_usdc_atomic: record.amount_usdc_atomic,
        network: record.network,
        tx_hash: record.tx_hash,
        completed_at: record.completed_at,
        verification_all_passed: record.verification_all_passed,
      });
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

  return { app, store, webhookDispatcher };
}
