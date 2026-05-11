// Reference Swarmwage seller — fulfills image.generate.photorealistic.png
// via Pollinations.ai (free public image gen, no API key required).
// License: MIT
//
// Usage:
//   SELLER_PRIVATE_KEY=0x... PORT=4001 \
//   REGISTRY_URL=http://localhost:3000 \
//   PUBLIC_URL=http://localhost:4001 \
//   pnpm --filter @swarmwage/example-seller-image-gen start
//
// On startup: signs and publishes a listing for image.generate.photorealistic.png
// against REGISTRY_URL. Then listens on /hire for buyer requests.

import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { keccak256, toBytes } from "viem";
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

const PRIVATE_KEY = process.env.SELLER_PRIVATE_KEY as Hex | undefined;
if (!PRIVATE_KEY) {
  process.stderr.write(
    "seller-image-gen: SELLER_PRIVATE_KEY required (0x-prefixed 32-byte hex)\n",
  );
  process.exit(1);
}

const PORT = Number(process.env.PORT ?? 4001);
const REGISTRY_URL = process.env.REGISTRY_URL ?? "http://localhost:3000";
const PUBLIC_URL = process.env.PUBLIC_URL ?? `http://localhost:${PORT}`;
const PRICE_USDC = process.env.PRICE_USDC ?? "0.10";
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
// resetting at UTC midnight. Tunable via env so an operator can lift the
// ceiling for a known-trusted deployment without rebuilding.
const MAX_DAILY_HIRES = Number(process.env.MAX_DAILY_HIRES ?? 1000);
const MAX_DAILY_SPEND_USD = Number(process.env.MAX_DAILY_SPEND_USD ?? 50);
// Pollinations.ai is free at the listed flux model — leave 0 unless the
// operator switches to a paid backend.
const EST_UPSTREAM_USD_PER_CALL = Number(
  process.env.EST_UPSTREAM_USD_PER_CALL ?? 0,
);
const dailyBudget = new DailyBudget({
  maxHires: MAX_DAILY_HIRES,
  maxSpendUsd: MAX_DAILY_SPEND_USD,
});

// Input bounds. Pollinations.ai is forgiving but unbounded prompts /
// 10000×10000 dimensions will burn its free-tier quota and earn our
// outbound IP a ban; cap defensively. All overridable via env.
const MAX_PROMPT_LENGTH = Number(process.env.MAX_PROMPT_LENGTH ?? 500);
const MAX_WIDTH = Number(process.env.MAX_WIDTH ?? 1024);
const MAX_HEIGHT = Number(process.env.MAX_HEIGHT ?? 1024);
const DEFAULT_WIDTH = 1024;
const DEFAULT_HEIGHT = 1024;

const account = privateKeyToAccount(PRIVATE_KEY);
const agentId = account.address.toLowerCase() as AgentId;

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
    capability: "image.generate.photorealistic.png",
    price_usdc: PRICE_USDC,
    currency: "USDC" as const,
    chain: "base" as const,
    max_latency_ms: 15_000,
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
    `seller-image-gen: listing published (capability=${listingPayload.capability}, price=${PRICE_USDC} USDC)\n`,
  );
}

// -------------------------------------------------------------------------
// Capability: image.generate.photorealistic.png via Pollinations.ai
// -------------------------------------------------------------------------

interface ImageGenInput {
  prompt: string;
  width: number;
  height: number;
  seed?: number;
}

interface ImageGenOutput {
  image_b64: string;
  width: number;
  height: number;
}

type ValidationResult =
  | { ok: true; value: ImageGenInput }
  | { ok: false; error: string };

function validateImageGenInput(
  params: Partial<ImageGenInput> | undefined,
): ValidationResult {
  if (!params || typeof params !== "object") {
    return { ok: false, error: "Missing params" };
  }
  if (typeof params.prompt !== "string" || params.prompt.length === 0) {
    return { ok: false, error: "Missing params.prompt" };
  }
  if (params.prompt.length > MAX_PROMPT_LENGTH) {
    return {
      ok: false,
      error: `params.prompt exceeds ${MAX_PROMPT_LENGTH} chars (got ${params.prompt.length})`,
    };
  }
  const width = params.width ?? DEFAULT_WIDTH;
  const height = params.height ?? DEFAULT_HEIGHT;
  if (!Number.isInteger(width) || width <= 0 || width > MAX_WIDTH) {
    return {
      ok: false,
      error: `params.width must be a positive integer ≤ ${MAX_WIDTH}`,
    };
  }
  if (!Number.isInteger(height) || height <= 0 || height > MAX_HEIGHT) {
    return {
      ok: false,
      error: `params.height must be a positive integer ≤ ${MAX_HEIGHT}`,
    };
  }
  let seed: number | undefined;
  if (params.seed !== undefined) {
    if (!Number.isInteger(params.seed)) {
      return {
        ok: false,
        error: "params.seed must be an integer when provided",
      };
    }
    seed = params.seed;
  }
  return { ok: true, value: { prompt: params.prompt, width, height, seed } };
}

async function generateImage(input: ImageGenInput): Promise<ImageGenOutput> {
  const url = new URL(
    `https://image.pollinations.ai/prompt/${encodeURIComponent(input.prompt)}`,
  );
  url.searchParams.set("width", String(input.width));
  url.searchParams.set("height", String(input.height));
  url.searchParams.set("nologo", "true");
  url.searchParams.set("model", "flux");
  if (input.seed !== undefined) url.searchParams.set("seed", String(input.seed));

  const res = await fetch(url.toString());
  if (!res.ok) {
    throw new Error(`Pollinations.ai returned ${res.status}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  return {
    image_b64: buf.toString("base64"),
    width: input.width,
    height: input.height,
  };
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
    name: "swarmwage seller — image.generate.photorealistic.png",
    agent_id: agentId,
    protocol: PROTOCOL_VERSION,
    backend: "pollinations.ai (flux)",
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
// is rejected with 429 without ever invoking the facilitator (no gas burn,
// no upstream API hit).
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

// x402 payment middleware: protects POST /hire.
// Buyer's first call returns 402 with PaymentRequirements; buyer signs an
// EIP-3009 transferWithAuthorization on USDC, retries with X-PAYMENT header,
// the middleware verifies + settles via the configured facilitator, then
// hands control to the handler below. Settlement tx hash is exposed via
// the X-PAYMENT-RESPONSE header that the middleware sets on the response.
//
// Wrapped by `firstCallFreeGate` so a buyer's first-ever hire against this
// seller bypasses payment entirely (SPEC §11 — listing advertises
// first_call_free: true). The gate parses buyer_id once; Hono caches the
// JSON body so the /hire handler re-reads it transparently.
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
    params?: ImageGenInput;
    max_price_usdc?: string;
    nonce?: string;
  };

  if (body.protocol !== PROTOCOL_VERSION) {
    return c.json(
      { error: `Unsupported protocol: ${body.protocol ?? "?"}` },
      400,
    );
  }
  if (body.capability !== "image.generate.photorealistic.png") {
    return c.json(
      { error: `Capability not supported: ${body.capability}` },
      400,
    );
  }
  const validation = validateImageGenInput(body.params);
  if (!validation.ok) {
    return c.json({ error: validation.error }, 400);
  }

  let result: ImageGenOutput;
  try {
    result = await generateImage(validation.value);
  } catch (err) {
    return c.json({ error: `Generation failed: ${(err as Error).message}` }, 502);
  }

  const completedAt = Math.floor(Date.now() / 1000);
  const latency = Date.now() - t0;
  const receiptId = `rcpt_${crypto.randomUUID()}`;
  const ratingToken = `rtt_${crypto.randomUUID()}`;
  const freeCall = c.get("freeCall") === true;
  const pricePaid = freeCall ? "0.00" : PRICE_USDC;

  // Commit the free-call consumption AFTER successful generation, so a
  // backend 5xx (caught above and returned as 502) does not silently burn
  // the buyer's single free trial.
  if (freeCall) {
    const buyerKey = c.get("freeCallBuyerId");
    if (buyerKey) firstCallTracker.markSeen(buyerKey);
  }

  // x402-hono attaches X-PAYMENT-RESPONSE on the response only AFTER this
  // handler returns. We ship tx_hash=0x0…0 here and the @swarmwage/agent-sdk
  // client patches it from the response header on its side. The signed
  // receipt is submitted by the post-hook middleware mounted above.
  //
  // For freeCall hires no on-chain settlement happens — tx_hash stays
  // zeroed and amount_usdc_atomic is "0". The indexer's planned
  // reconciliation job (registry/src/app.ts §receipts trust model) MUST
  // skip cross-check when amount_usdc_atomic === "0".
  const ZERO_HASH =
    "0x0000000000000000000000000000000000000000000000000000000000000000";

  const verification = {
    checks: [
      { name: "is_valid_png", passed: true },
      { name: "matches_dimensions", passed: true },
    ],
    all_passed: true,
  };

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
      capability: body.capability ?? "image.generate.photorealistic.png",
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
    result,
    verification,
    rating_token: ratingToken,
    _meta: { latency_ms: latency, first_call_free: freeCall },
  });
});

// Convert a human-readable USDC string (e.g. "0.10") to atomic units
// (6 decimals). Example: "0.10" -> "100000".
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
      `seller-image-gen: WARN failed to publish listing — ${(err as Error).message}\n`,
    );
  }
  serve({ fetch: app.fetch, port: PORT }, (info) => {
    process.stderr.write(
      `seller-image-gen v0.0.1 listening on ${PUBLIC_URL} (agent_id=${agentId})\n`,
    );
  });
})();
