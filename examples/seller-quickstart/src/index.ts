// Swarmwage seller QUICKSTART — wrap an existing HTTP API as a paid agent.
// License: MIT
//
// This is the "facilissimo" path: if you ALREADY have an HTTP API (a scraper,
// an enrichment endpoint, a transcription service, an ad generator…), you do
// NOT need to rewrite it. This server puts a payable x402 wrapper in front of
// your existing API:
//
//   buyer agent → POST /hire  (pays USDC via x402)
//                   → this wrapper forwards `params` to UPSTREAM_URL
//                   → returns your API's JSON back to the buyer
//                   → submits a signed receipt to the Swarmwage registry
//
// You configure everything with env vars — no code edit required for the
// common case. If your existing API expects a different request shape than
// the buyer sends in `params`, edit the one marked block in `callUpstream`.
//
// Quickstart:
//   1. cp .env.example .env   and fill it in
//   2. pnpm install && pnpm start   (or: npm install && npm start)
//   3. expose PORT on a public HTTPS URL (PUBLIC_URL) — e.g. a $5 box + Caddy,
//      Fly.io, Railway, Render, or a Cloudflare tunnel.
// The listing is published to the registry automatically on boot.

import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { keccak256, toBytes } from "viem";
import { canonicalize } from "@swarmwage/agent-sdk";
import { privateKeyToAccount } from "viem/accounts";
import { paymentMiddleware, type Network } from "x402-hono";
import {
  PROTOCOL_VERSION,
  submitReceipt,
  type AgentId,
  type Hex,
  ENDPOINT_VERIFY_PATH,
  signEndpointVerify,
  type Listing,
} from "@swarmwage/agent-sdk";
import { clientIp, rateLimit, SlidingWindowLimiter } from "./rate-limit.js";
import { DailyBudget, dailyBudgetGuard } from "./daily-budget.js";
import { firstCallFreeGate, inMemoryTracker } from "./first-call-free.js";

// -------------------------------------------------------------------------
// Required config
// -------------------------------------------------------------------------

const PRIVATE_KEY = process.env.SELLER_PRIVATE_KEY as Hex | undefined;
if (!PRIVATE_KEY) {
  process.stderr.write(
    "seller-quickstart: SELLER_PRIVATE_KEY required (0x-prefixed 32-byte hex).\n" +
      "This is the wallet that RECEIVES USDC. Keep it secret.\n",
  );
  process.exit(1);
}

// The capability you sell, e.g. "research.scrape.json" or
// "custom.yourbrand.enrich". See packages/protocol/CAPABILITIES.md for the
// standard taxonomy; out-of-tree capabilities MUST use the `custom.` prefix.
const CAPABILITY = process.env.CAPABILITY;
if (!CAPABILITY) {
  process.stderr.write(
    "seller-quickstart: CAPABILITY required (e.g. research.scrape.json or custom.brand.name).\n",
  );
  process.exit(1);
}

// Your existing API endpoint that actually does the work.
const UPSTREAM_URL = process.env.UPSTREAM_URL;
if (!UPSTREAM_URL) {
  process.stderr.write(
    "seller-quickstart: UPSTREAM_URL required (the existing API this wrapper forwards to).\n",
  );
  process.exit(1);
}

// -------------------------------------------------------------------------
// Optional config (sane defaults)
// -------------------------------------------------------------------------

const PORT = Number(process.env.PORT ?? 4010);
const REGISTRY_URL = process.env.REGISTRY_URL ?? "https://api.swarmwage.com";
const PUBLIC_URL = process.env.PUBLIC_URL ?? `http://localhost:${PORT}`;
const PRICE_USDC = process.env.PRICE_USDC ?? "0.02";
const MAX_LATENCY_MS = Number(process.env.MAX_LATENCY_MS ?? 15_000);
const FIRST_CALL_FREE = process.env.FIRST_CALL_FREE !== "0"; // default ON for discovery
const NETWORK = (process.env.NETWORK ?? "base") as Network;
// Default to the Swarmwage facilitator (gas-relay only, never custodies USDC).
const FACILITATOR_URL = (process.env.FACILITATOR_URL ??
  "https://facilitator.swarmwage.com") as `${string}://${string}`;

// How to forward to your upstream. Default: POST the buyer's `params` as JSON.
const UPSTREAM_METHOD = (process.env.UPSTREAM_METHOD ?? "POST").toUpperCase();
const UPSTREAM_AUTH_HEADER = process.env.UPSTREAM_AUTH_HEADER; // e.g. "Authorization"
const UPSTREAM_AUTH_VALUE = process.env.UPSTREAM_AUTH_VALUE; // e.g. "Bearer sk-..."
const UPSTREAM_TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS ?? 30_000);

// Per-IP flood guard + per-day caps (defend your upstream quota / bill).
const HIRE_RATE_LIMIT_PER_IP = Number(process.env.HIRE_RATE_LIMIT_PER_IP ?? 20);
const HIRE_RATE_WINDOW_MS = Number(process.env.HIRE_RATE_WINDOW_MS ?? 60_000);
const MAX_DAILY_HIRES = Number(process.env.MAX_DAILY_HIRES ?? 1000);
const MAX_DAILY_SPEND_USD = Number(process.env.MAX_DAILY_SPEND_USD ?? 50);
const EST_UPSTREAM_USD_PER_CALL = Number(
  process.env.EST_UPSTREAM_USD_PER_CALL ?? 0.001,
);

const account = privateKeyToAccount(PRIVATE_KEY);
const agentId = account.address.toLowerCase() as AgentId;

const hireIpLimiter = new SlidingWindowLimiter({
  limit: HIRE_RATE_LIMIT_PER_IP,
  windowMs: HIRE_RATE_WINDOW_MS,
});
setInterval(() => hireIpLimiter.gc(), HIRE_RATE_WINDOW_MS).unref();

const dailyBudget = new DailyBudget({
  maxHires: MAX_DAILY_HIRES,
  maxSpendUsd: MAX_DAILY_SPEND_USD,
});

// -------------------------------------------------------------------------
// Forward to the existing upstream API
// -------------------------------------------------------------------------

interface UpstreamResult {
  result: unknown;
  ok: boolean;
  status: number;
}

async function callUpstream(params: unknown): Promise<UpstreamResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
    };
    if (UPSTREAM_AUTH_HEADER && UPSTREAM_AUTH_VALUE) {
      headers[UPSTREAM_AUTH_HEADER] = UPSTREAM_AUTH_VALUE;
    }

    // -- EDIT HERE if your API needs a different request shape ------------
    // By default we forward the buyer's `params` object verbatim as the JSON
    // body. If your existing API expects a different schema, map `params`
    // into it here, e.g.:  const body = { query: (params as any).url };
    const body = JSON.stringify(params);
    // --------------------------------------------------------------------

    const res = await fetch(UPSTREAM_URL!, {
      method: UPSTREAM_METHOD === "GET" ? "GET" : "POST",
      headers,
      body: UPSTREAM_METHOD === "GET" ? undefined : body,
      signal: controller.signal,
    });
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Upstream returned non-JSON (e.g. plain text / base64). Pass it through.
      parsed = { raw: text };
    }
    return { result: parsed, ok: res.ok, status: res.status };
  } finally {
    clearTimeout(timer);
  }
}

// -------------------------------------------------------------------------
// Sign + publish listing
// -------------------------------------------------------------------------

async function signTypedPayload(payload: object): Promise<Hex> {
  const canonical = canonicalize(payload);
  const hash = keccak256(toBytes(canonical));
  return account.signMessage({ message: { raw: hash } });
}

async function publishListing(): Promise<void> {
  const listingPayload = {
    agent_id: agentId,
    capability: CAPABILITY!,
    price_usdc: PRICE_USDC,
    currency: "USDC" as const,
    // The registry registers mainnet listings. NETWORK still controls the
    // x402 middleware (use base-sepolia locally to test the payment flow).
    chain: "base" as const,
    max_latency_ms: MAX_LATENCY_MS,
    first_call_free: FIRST_CALL_FREE,
    endpoint: PUBLIC_URL,
  };
  const signature = await signTypedPayload(listingPayload);
  const listing: Listing = { ...listingPayload, signature };

  const res = await fetch(`${REGISTRY_URL}/v1/listings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(listing),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Failed to publish listing: ${res.status} ${txt}`);
  }
  process.stderr.write(
    `seller-quickstart: listing published (capability=${CAPABILITY}, price=${PRICE_USDC} USDC, endpoint=${PUBLIC_URL})\n`,
  );
}

// Convert "0.02" → "20000" (USDC has 6 decimals).
function priceUsdcToAtomic(price: string): string {
  const [intPart, fracPart = ""] = price.split(".");
  const frac = (fracPart + "000000").slice(0, 6);
  const combined = `${intPart}${frac}`.replace(/^0+(?=\d)/, "");
  return combined === "" ? "0" : combined;
}

// -------------------------------------------------------------------------
// HTTP server
// -------------------------------------------------------------------------

type Variables = {
  pendingReceipt?: { payload: Parameters<typeof submitReceipt>[0]["payload"] };
  freeCall?: boolean;
  freeCallBuyerId?: string;
};
const firstCallTracker = inMemoryTracker();
const app = new Hono<{ Variables: Variables }>();

const ZERO_HASH = (`0x${"0".repeat(64)}`) as `0x${string}`;

app.get("/", (c) =>
  c.json({
    name: `swarmwage seller — ${CAPABILITY}`,
    agent_id: agentId,
    protocol: PROTOCOL_VERSION,
    network: NETWORK,
    price_usdc: PRICE_USDC,
    upstream: "configured",
  }),
);

// Endpoint ownership proof: lets the registry confirm we control the same
// wallet as `agent_id` by signing a nonce.
app.get(ENDPOINT_VERIFY_PATH, async (c) => {
  const nonce = c.req.query("nonce");
  if (!nonce || nonce.length < 8 || nonce.length > 128) {
    return c.json({ error: "Invalid or missing nonce" }, 400);
  }
  return c.json(await signEndpointVerify(agentId, nonce, signTypedPayload));
});

// Flood guard — rejects with 429 before ever invoking the facilitator.
app.use("/hire", rateLimit(hireIpLimiter, clientIp));
// Daily caps — 503 once the day's hire count or upstream spend cap is hit.
app.use("/hire", dailyBudgetGuard(dailyBudget, EST_UPSTREAM_USD_PER_CALL));

// Receipt post-hook — runs AFTER paymentMiddleware attaches X-PAYMENT-RESPONSE.
app.use("/hire", async (c, next) => {
  await next();
  const pending = c.get("pendingReceipt");
  if (!pending) return;
  if (c.res.status >= 400) return;
  let txHash = ZERO_HASH;
  const header = c.res.headers.get("X-PAYMENT-RESPONSE");
  if (header) {
    try {
      const decoded = JSON.parse(
        Buffer.from(header, "base64").toString("utf8"),
      ) as { transaction?: string; txHash?: string };
      const candidate = decoded.transaction ?? decoded.txHash;
      if (candidate?.startsWith("0x")) txHash = candidate as `0x${string}`;
    } catch {
      // header malformed — keep placeholder
    }
  }
  void submitReceipt({
    registryUrl: REGISTRY_URL,
    sellerPrivateKey: PRIVATE_KEY,
    payload: { ...pending.payload, tx_hash: txHash },
  });
});

// x402 payment, wrapped so a buyer's first hire is free (discovery primitive).
const pmw = paymentMiddleware(
  account.address,
  { "POST /hire": { price: `$${PRICE_USDC}`, network: NETWORK } },
  { url: FACILITATOR_URL },
);
app.use(
  "/hire",
  FIRST_CALL_FREE
    ? firstCallFreeGate({ paymentMiddleware: pmw, tracker: firstCallTracker })
    : pmw,
);

app.post("/hire", async (c) => {
  const t0 = Date.now();
  const body = (await c.req.json()) as {
    protocol?: string;
    buyer_id?: AgentId;
    capability?: string;
    params?: unknown;
  };

  if (body.protocol !== PROTOCOL_VERSION) {
    return c.json({ error: `Unsupported protocol: ${body.protocol ?? "?"}` }, 400);
  }
  if (body.capability !== CAPABILITY) {
    return c.json({ error: `Capability not supported: ${body.capability}` }, 400);
  }

  let upstream: UpstreamResult;
  try {
    upstream = await callUpstream(body.params ?? {});
  } catch (err) {
    process.stderr.write(
      `seller-quickstart: upstream call failed — ${(err as Error).message}\n`,
    );
    return c.json({ error: `Upstream failed: ${(err as Error).message}` }, 502);
  }
  if (!upstream.ok) {
    return c.json(
      { error: `Upstream returned HTTP ${upstream.status}`, result: upstream.result },
      502,
    );
  }

  const completedAt = Math.floor(Date.now() / 1000);
  const latency = Date.now() - t0;
  const receiptId = `rcpt_${crypto.randomUUID()}`;
  const ratingToken = `rtt_${crypto.randomUUID()}`;
  const freeCall = c.get("freeCall") === true;
  const pricePaid = freeCall ? "0.00" : PRICE_USDC;

  if (freeCall) {
    const buyerKey = c.get("freeCallBuyerId");
    if (buyerKey) firstCallTracker.markSeen(buyerKey);
  }

  // Generic verification: upstream answered 2xx with a non-empty body.
  const nonEmpty =
    upstream.result != null &&
    !(typeof upstream.result === "object" &&
      Object.keys(upstream.result as object).length === 0);
  const verification = {
    checks: [
      { name: "upstream_2xx", passed: true },
      { name: "non_empty_result", passed: nonEmpty },
    ],
    all_passed: nonEmpty,
  };

  c.set("pendingReceipt", {
    payload: {
      protocol_version: PROTOCOL_VERSION,
      hire_id: receiptId,
      agent_id: agentId,
      buyer:
        (body.buyer_id?.toLowerCase() as AgentId) ??
        ("0x0000000000000000000000000000000000000000" as AgentId),
      capability: CAPABILITY!,
      amount_usdc_atomic: freeCall ? "0" : priceUsdcToAtomic(PRICE_USDC),
      network: NETWORK as "base" | "base-sepolia",
      tx_hash: ZERO_HASH as `0x${string}`,
      completed_at: new Date(completedAt * 1000).toISOString(),
      verification: {
        all_passed: verification.all_passed,
        checks: Object.fromEntries(
          verification.checks.map((v) => [v.name, v.passed]),
        ),
      },
    },
  });

  return c.json({
    protocol: PROTOCOL_VERSION,
    receipt: {
      receipt_id: receiptId,
      buyer_id: body.buyer_id ?? "0x0000000000000000000000000000000000000000",
      seller_id: agentId,
      capability: body.capability,
      tx_hash: ZERO_HASH,
      price_paid_usdc: pricePaid,
      completed_at: completedAt,
      first_call_free: freeCall,
    },
    result: upstream.result,
    verification,
    rating_token: ratingToken,
    _meta: { latency_ms: latency, first_call_free: freeCall },
  });
});

// -------------------------------------------------------------------------
// Boot
// -------------------------------------------------------------------------

(async () => {
  try {
    await publishListing();
  } catch (err) {
    process.stderr.write(
      `seller-quickstart: WARN failed to publish listing — ${(err as Error).message}\n`,
    );
  }
  serve({ fetch: app.fetch, port: PORT }, () => {
    process.stderr.write(
      `seller-quickstart v0.0.1 listening on ${PUBLIC_URL} (agent_id=${agentId}, capability=${CAPABILITY})\n`,
    );
  });
})();
