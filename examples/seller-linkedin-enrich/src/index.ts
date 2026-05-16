// © 2026 Swarmwage. MIT.
// Reference Swarmwage seller — fulfills research.linkedin.profile.enrich
// by wrapping the Apify LinkedIn Profile Scraper actor.
//
// Usage:
//   SELLER_PRIVATE_KEY=0x... APIFY_API_TOKEN=apify_api_... PORT=4006 \
//     REGISTRY_URL=http://localhost:3000 \
//     pnpm --filter @swarmwage/example-seller-linkedin-enrich start
//
// Backend pipeline:
//   1. validate input (profile_url), SSRF-guard + linkedin.com/in/ allowlist
//   2. POST profileUrls=[profile_url] to apify/linkedin-profile-scraper
//      run-sync-get-dataset-items
//   3. normalize first dataset item → canonical profile shape
//   4. run verifier mirror (output_is_object, profile_has_url,
//      profile_has_name, source_is_apify) before responding

import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { keccak256, toBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { paymentMiddleware, type Network } from "x402-hono";
import { z } from "zod";
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
import { enrichProfile, EnrichBackendError } from "./enrich.js";
import { verifyProfile } from "./verify.js";
import { firstCallFreeGate, inMemoryTracker } from "./first-call-free.js";

const PRIVATE_KEY = process.env.SELLER_PRIVATE_KEY as Hex | undefined;
if (!PRIVATE_KEY) {
  process.stderr.write(
    "seller-linkedin-enrich: SELLER_PRIVATE_KEY required (0x-prefixed 32-byte hex)\n",
  );
  process.exit(1);
}

const APIFY_API_TOKEN = process.env.APIFY_API_TOKEN;
if (!APIFY_API_TOKEN) {
  process.stderr.write(
    "seller-linkedin-enrich: APIFY_API_TOKEN required\n",
  );
  process.exit(1);
}

const PORT = Number(process.env.PORT ?? 4006);
const REGISTRY_URL = process.env.REGISTRY_URL ?? "http://localhost:3000";
const PUBLIC_URL = process.env.PUBLIC_URL ?? `http://localhost:${PORT}`;
const PRICE_USDC = process.env.PRICE_USDC ?? "0.50";
const NETWORK = (process.env.NETWORK ?? "base-sepolia") as Network;
const FACILITATOR_URL = (process.env.FACILITATOR_URL ??
  "https://x402.org/facilitator") as `${string}://${string}`;

// Per-IP rate limit on /hire. Tunable via env so an operator can tighten
// or loosen for a known-trusted deployment without rebuilding.
const HIRE_RATE_LIMIT_PER_IP = Number(
  process.env.HIRE_RATE_LIMIT_PER_IP ?? 20,
);
const HIRE_RATE_WINDOW_MS = Number(process.env.HIRE_RATE_WINDOW_MS ?? 60_000);
const hireIpLimiter = new SlidingWindowLimiter({
  limit: HIRE_RATE_LIMIT_PER_IP,
  windowMs: HIRE_RATE_WINDOW_MS,
});
setInterval(() => hireIpLimiter.gc(), HIRE_RATE_WINDOW_MS).unref();

// Per-day budget guard. Caps both hire count AND cumulative upstream USD,
// resetting at UTC midnight. Apify LinkedIn Profile Scraper is paid usage
// (~$0.01-0.05 per profile depending on plan); treat 0.05 as the
// conservative upper bound per call.
const MAX_DAILY_HIRES = Number(process.env.MAX_DAILY_HIRES ?? 500);
const MAX_DAILY_SPEND_USD = Number(process.env.MAX_DAILY_SPEND_USD ?? 25);
const EST_UPSTREAM_USD_PER_CALL = Number(
  process.env.EST_UPSTREAM_USD_PER_CALL ?? 0.05,
);
const dailyBudget = new DailyBudget({
  maxHires: MAX_DAILY_HIRES,
  maxSpendUsd: MAX_DAILY_SPEND_USD,
});

const APIFY_TIMEOUT_MS = Number(process.env.APIFY_TIMEOUT_MS ?? 90_000);
const MAX_PROFILE_URL_LEN = 256;

const account = privateKeyToAccount(PRIVATE_KEY);
const agentId = account.address.toLowerCase() as AgentId;

// -------------------------------------------------------------------------
// Input schema (zod) — LinkedIn-only allowlist, length-capped
// -------------------------------------------------------------------------

const LINKEDIN_PROFILE_RE =
  /^https:\/\/(?:www\.)?linkedin\.com\/in\/[A-Za-z0-9\-_%.]+\/?$/;

const HireParams = z.object({
  profile_url: z
    .string()
    .max(MAX_PROFILE_URL_LEN, `profile_url must be <= ${MAX_PROFILE_URL_LEN} chars`)
    .regex(
      LINKEDIN_PROFILE_RE,
      "profile_url must be https://(www.)?linkedin.com/in/<slug>",
    ),
});

type HireParamsType = z.infer<typeof HireParams>;

// -------------------------------------------------------------------------
// SSRF guard — belt-and-suspenders on top of the regex. Rejects any URL
// whose hostname is not linkedin.com or www.linkedin.com, blocks localhost
// and private IP ranges, and requires https.
// -------------------------------------------------------------------------

class UnsafeUrl extends Error {}

function assertLinkedInUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new UnsafeUrl("invalid URL");
  }
  if (u.protocol !== "https:") {
    throw new UnsafeUrl(`unsupported protocol: ${u.protocol}`);
  }
  const host = u.hostname.toLowerCase();
  if (host !== "linkedin.com" && host !== "www.linkedin.com") {
    throw new UnsafeUrl(`host not allowed: ${host}`);
  }
  if (!u.pathname.toLowerCase().startsWith("/in/")) {
    throw new UnsafeUrl("path must start with /in/");
  }
  return u;
}

// -------------------------------------------------------------------------
// End-to-end pipeline
// -------------------------------------------------------------------------

async function runEnrichment(input: HireParamsType) {
  // Re-assert (defense in depth — schema already validated, but if anyone
  // bypasses the schema this still catches it before we hit Apify).
  const u = assertLinkedInUrl(input.profile_url);
  return enrichProfile({
    profileUrl: u.toString(),
    apifyApiToken: APIFY_API_TOKEN!,
    apifyTimeoutMs: APIFY_TIMEOUT_MS,
  });
}

// -------------------------------------------------------------------------
// Sign + publish listing
// -------------------------------------------------------------------------

async function signTypedPayload(payload: object): Promise<Hex> {
  const canonical = JSON.stringify(payload, Object.keys(payload).sort());
  const hash = keccak256(toBytes(canonical));
  return account.signMessage({ message: { raw: hash } });
}

async function publishListing(): Promise<void> {
  const listingPayload = {
    agent_id: agentId,
    capability: "research.linkedin.profile.enrich",
    price_usdc: PRICE_USDC,
    currency: "USDC" as const,
    chain: "base" as const,
    max_latency_ms: 90_000,
    first_call_free: true,
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
    `seller-linkedin-enrich: listing published (capability=${listingPayload.capability}, price=${PRICE_USDC} USDC)\n`,
  );
}

// -------------------------------------------------------------------------
// HTTP server
// -------------------------------------------------------------------------

type Variables = {
  pendingReceipt?: {
    payload: Parameters<typeof submitReceipt>[0]["payload"];
  };
  freeCall?: boolean;
  freeCallBuyerId?: string;
};
const firstCallTracker = inMemoryTracker();
const app = new Hono<{ Variables: Variables }>();

app.get("/", (c) =>
  c.json({
    name: "swarmwage seller — research.linkedin.profile.enrich",
    agent_id: agentId,
    protocol: PROTOCOL_VERSION,
    backend: "apify:apify/linkedin-profile-scraper",
    network: NETWORK,
    price_usdc: PRICE_USDC,
  }),
);

// Endpoint ownership proof (Wave 2a). Lets the registry confirm we
// control the same wallet as `agent_id` by signing a nonce. Closes the
// squat where a different agent_id is bound to a third-party endpoint.
app.get(ENDPOINT_VERIFY_PATH, async (c) => {
  const nonce = c.req.query("nonce");
  if (!nonce || nonce.length < 8 || nonce.length > 128) {
    return c.json({ error: "Invalid or missing nonce" }, 400);
  }
  return c.json(await signEndpointVerify(agentId, nonce, signTypedPayload));
});

// Per-IP flood guard. Mounted BEFORE paymentMiddleware so a flood attack
// is rejected with 429 without ever invoking the facilitator.
app.use("/hire", rateLimit(hireIpLimiter, clientIp));

// Per-day budget guard — closes /hire with 503 once the day's hire count or
// upstream spend cap is hit. Mounted before paymentMiddleware so the buyer
// is never charged USDC for a call we cannot fulfil.
app.use("/hire", dailyBudgetGuard(dailyBudget, EST_UPSTREAM_USD_PER_CALL));

// Receipt-submission post-hook. Mounted BEFORE paymentMiddleware so its
// post-await(next) phase runs AFTER paymentMiddleware has attached the
// X-PAYMENT-RESPONSE header (which carries the real settlement tx_hash).
// The /hire handler stashes the receipt payload via c.set("pendingReceipt").
app.use("/hire", async (c, next) => {
  await next();
  const pending = c.get("pendingReceipt") as
    | { payload: Parameters<typeof submitReceipt>[0]["payload"] }
    | undefined;
  if (!pending) return;
  if (c.res.status >= 400) return;
  let txHash =
    "0x0000000000000000000000000000000000000000000000000000000000000000";
  const paymentResponseHeader = c.res.headers.get("X-PAYMENT-RESPONSE");
  if (paymentResponseHeader) {
    try {
      const decoded = JSON.parse(
        Buffer.from(paymentResponseHeader, "base64").toString("utf8"),
      ) as { transaction?: string; txHash?: string };
      txHash = decoded.transaction ?? decoded.txHash ?? txHash;
    } catch {
      // header malformed — keep placeholder
    }
  }
  void submitReceipt({
    registryUrl: REGISTRY_URL,
    sellerPrivateKey: PRIVATE_KEY,
    payload: { ...pending.payload, tx_hash: txHash as `0x${string}` },
  });
});

// Wrapped by `firstCallFreeGate` so a buyer's first-ever hire against this
// seller bypasses payment (SPEC §11 — listing advertises first_call_free).
const pmw = paymentMiddleware(
  account.address,
  {
    "POST /hire": {
      price: `$${PRICE_USDC}`,
      network: NETWORK,
    },
  },
  { url: FACILITATOR_URL },
);

app.use(
  "/hire",
  firstCallFreeGate({ paymentMiddleware: pmw, tracker: firstCallTracker }),
);

app.post("/hire", async (c) => {
  const t0 = Date.now();
  const body = (await c.req.json()) as {
    protocol?: string;
    buyer_id?: AgentId;
    capability?: string;
    params?: unknown;
    max_price_usdc?: string;
    nonce?: string;
  };

  if (body.protocol !== PROTOCOL_VERSION) {
    return c.json(
      { error: `Unsupported protocol: ${body.protocol ?? "?"}` },
      400,
    );
  }
  if (body.capability !== "research.linkedin.profile.enrich") {
    return c.json(
      { error: `Capability not supported: ${body.capability}` },
      400,
    );
  }

  const parsed = HireParams.safeParse(body.params);
  if (!parsed.success) {
    return c.json(
      {
        error: "params validation failed",
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      },
      400,
    );
  }

  let result: Awaited<ReturnType<typeof runEnrichment>>;
  try {
    result = await runEnrichment(parsed.data);
  } catch (err) {
    if (err instanceof UnsafeUrl) {
      return c.json({ error: `Refused URL: ${err.message}` }, 400);
    }
    if (err instanceof EnrichBackendError) {
      process.stderr.write(
        `seller-linkedin-enrich: backend failure (${err.stage}) — ${err.message}\n`,
      );
      return c.json(
        { error: `Enrichment failed: ${err.message}`, stage: err.stage },
        502,
      );
    }
    process.stderr.write(
      `seller-linkedin-enrich: enrichment failed — ${(err as Error).message}\n`,
    );
    return c.json(
      { error: `Enrichment failed: ${(err as Error).message}` },
      502,
    );
  }

  const profile = result.profile;
  const verification = verifyProfile({ profile });
  if (!verification.all_passed) {
    process.stderr.write(
      `seller-linkedin-enrich: verifier rejected output — ${JSON.stringify(verification.checks)}\n`,
    );
    return c.json(
      {
        error: "Backend output failed local verification",
        verification,
      },
      502,
    );
  }

  const completedAt = Math.floor(Date.now() / 1000);
  const latency = Date.now() - t0;
  const receiptId = `rcpt_${crypto.randomUUID()}`;
  const ratingToken = `rtt_${crypto.randomUUID()}`;
  const freeCall = c.get("freeCall") === true;
  const pricePaid = freeCall ? "0.00" : PRICE_USDC;

  // Commit free-call consumption only after a successful enrichment +
  // verification pass.
  if (freeCall) {
    const buyerKey = c.get("freeCallBuyerId");
    if (buyerKey) firstCallTracker.markSeen(buyerKey);
  }

  // x402-hono attaches X-PAYMENT-RESPONSE on the response only AFTER this
  // handler returns. We ship tx_hash=0x0…0 here and the @swarmwage/agent-sdk
  // client patches it from the response header on its side. The signed
  // receipt is submitted by the post-hook middleware mounted above.
  const ZERO_HASH =
    "0x0000000000000000000000000000000000000000000000000000000000000000";

  // Stash the receipt payload (without tx_hash) for the post-hook to pick up
  // and submit once X-PAYMENT-RESPONSE is attached to the response.
  c.set("pendingReceipt", {
    payload: {
      protocol_version: PROTOCOL_VERSION,
      hire_id: receiptId,
      agent_id: agentId,
      buyer:
        (body.buyer_id?.toLowerCase() as AgentId) ??
        ("0x0000000000000000000000000000000000000000" as AgentId),
      capability: body.capability ?? "research.linkedin.profile.enrich",
      amount_usdc_atomic: freeCall ? "0" : priceUsdcToAtomic(PRICE_USDC),
      network: NETWORK as "base" | "base-sepolia",
      tx_hash: ZERO_HASH as `0x${string}`,
      completed_at: new Date(completedAt * 1000).toISOString(),
      verification: {
        all_passed: verification.all_passed,
        checks: Object.fromEntries(
          verification.checks.map((c) => [c.name, c.passed]),
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
    result: {
      profile,
    },
    verification,
    rating_token: ratingToken,
    _meta: {
      backend_used: result.meta.backend_used,
      duration_ms: result.meta.duration_ms,
      latency_ms: latency,
      first_call_free: freeCall,
    },
  });
});

// Convert "0.50" → "500000" (USDC has 6 decimals).
function priceUsdcToAtomic(price: string): string {
  const [intPart, fracPart = ""] = price.split(".");
  const frac = (fracPart + "000000").slice(0, 6);
  const combined = `${intPart}${frac}`.replace(/^0+(?=\d)/, "");
  return combined === "" ? "0" : combined;
}

// -------------------------------------------------------------------------
// Boot
// -------------------------------------------------------------------------

(async () => {
  try {
    await publishListing();
  } catch (err) {
    process.stderr.write(
      `seller-linkedin-enrich: WARN failed to publish listing — ${(err as Error).message}\n`,
    );
  }

  serve({ fetch: app.fetch, port: PORT }, () => {
    process.stderr.write(
      `seller-linkedin-enrich v0.1.0 listening on ${PUBLIC_URL} (agent_id=${agentId})\n`,
    );
  });
})();
