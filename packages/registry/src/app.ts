// Swarmwage Registry — Hono app factory
// License: BUSL-1.1
//
// Builds and returns a configured Hono app + the underlying store. Kept
// separate from `index.ts` so tests can spin up a fresh app without
// binding a TCP port. Route handlers live in `routes/` — this file owns
// middleware (CORS, body cap, rate limits), the public route index, and
// the wiring between the two.

import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { logger } from "hono/logger";

import { PROTOCOL_VERSION } from "@swarmwage/agent-sdk";

import { rateLimit } from "./rate-limit.js";
import { MemoryStore } from "./store/memory.js";
import type { RegistryStore } from "./store/types.js";
import { WebhookDispatcher } from "./webhooks.js";
import {
  createAgentListingsHandler,
  createAgentReceiptsHandler,
  createReputationHandler,
} from "./routes/agents.js";
import {
  createClaimStartHandler,
  createClaimVerifyHandler,
} from "./routes/claim.js";
import {
  createListExternalX402ReliabilityHandler,
  createSubmitExternalX402ReliabilityHandler,
} from "./routes/external-x402-reliability.js";
import {
  createListingsLookupHandler,
  createPublishListingHandler,
  PublishRateLimiter,
} from "./routes/listings.js";
import { createRateHandler } from "./routes/rate.js";
import { createSubmitReceiptHandler } from "./routes/receipts.js";
import { createSearchHandler } from "./routes/search.js";
import { createTelemetryHandler } from "./routes/telemetry.js";

export interface CreateAppOptions {
  store?: RegistryStore;
  /** When false, the HTTP request logger middleware is skipped (test noise). */
  enableRequestLogger?: boolean;
  /** Outbound webhook dispatcher. When omitted, no webhooks are fired. */
  webhookDispatcher?: WebhookDispatcher;
  /**
   * Endpoint ownership proof mode (Wave 2a). See env.ts for semantics:
   * `off` skips the challenge (default — tests + memory-store use this),
   * `soft` challenges and logs but still accepts, `enforce` rejects with
   * HTTP 400 on a failed challenge.
   */
  endpointVerifyMode?: "off" | "soft" | "enforce";
  /** Wall-clock budget for the verify GET. Defaults to 5000 ms. */
  endpointVerifyTimeoutMs?: number;
  /** Stubbable fetch + nonce for endpoint-verify tests. */
  endpointVerifyOverrides?: {
    fetchFn?: typeof fetch;
    nonceFn?: () => string;
  };
}

export interface CreatedApp {
  app: Hono;
  store: RegistryStore;
  webhookDispatcher: WebhookDispatcher | undefined;
}

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
      "Search active listings by capability. Body: { capability, match?: 'exact'|'prefix', max_price_usdc?, max_latency_ms?, min_success_rate?, min_avg_stars?, limit? }. On empty result, response additionally carries `available_capabilities` (up to 20) and `total_distinct_capabilities` so callers can discover the live catalogue.",
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
    path: "/v1/reliability/external-x402",
    description:
      "Submit a client-observed reliability record for a third-party x402 endpoint.",
  },
  {
    method: "GET",
    path: "/v1/reliability/external-x402",
    description:
      "List client-observed reliability aggregates for third-party x402 endpoints.",
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
  // External reliability writes are unauthenticated client observations.
  app.use("/v1/reliability/external-x402", floodGuard);

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

  app.post("/v1/search", createSearchHandler(store));

  app.post(
    "/v1/listings",
    createPublishListingHandler({
      store,
      publishLimiter: new PublishRateLimiter(),
      endpointVerifyMode: opts.endpointVerifyMode ?? "off",
      endpointVerifyTimeoutMs: opts.endpointVerifyTimeoutMs ?? 5000,
      endpointVerifyOverrides: opts.endpointVerifyOverrides,
    }),
  );
  app.get(
    "/v1/listings",
    createListingsLookupHandler({
      store,
      indexPayload: (capability_count) => ({
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
      }),
    }),
  );

  app.get("/v1/agents/:id/reputation", createReputationHandler(store));
  app.get("/v1/agents/:id/listings", createAgentListingsHandler(store));
  app.get("/v1/agents/:id/receipts", createAgentReceiptsHandler(store));

  app.post("/v1/rate", createRateHandler());

  app.post("/v1/claim", createClaimStartHandler(store));
  app.post("/v1/claim/verify", createClaimVerifyHandler(store));

  app.post(
    "/v1/receipts",
    createSubmitReceiptHandler({ store, webhookDispatcher }),
  );
  app.post(
    "/v1/reliability/external-x402",
    createSubmitExternalX402ReliabilityHandler(store),
  );
  app.get(
    "/v1/reliability/external-x402",
    createListExternalX402ReliabilityHandler(store),
  );

  app.post("/telemetry", createTelemetryHandler(store));

  return { app, store, webhookDispatcher };
}
