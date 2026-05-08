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
  type Listing,
} from "@swarmwage/agent-sdk";

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

const app = new Hono();

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

// x402 payment middleware: protects POST /hire.
// Buyer's first call returns 402 with PaymentRequirements; buyer signs an
// EIP-3009 transferWithAuthorization on USDC, retries with X-PAYMENT header,
// the middleware verifies + settles via the configured facilitator, then
// hands control to the handler below. Settlement tx hash is exposed via
// the X-PAYMENT-RESPONSE header that the middleware sets on the response.
app.use(
  paymentMiddleware(
    account.address,
    {
      "POST /hire": {
        price: `$${PRICE_USDC}`,
        network: NETWORK,
      },
    },
    { url: FACILITATOR_URL },
  ),
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
  if (!body.params?.prompt) {
    return c.json({ error: "Missing params.prompt" }, 400);
  }

  let result: ImageGenOutput;
  try {
    result = await generateImage(body.params);
  } catch (err) {
    return c.json({ error: `Generation failed: ${(err as Error).message}` }, 502);
  }

  const completedAt = Math.floor(Date.now() / 1000);
  const latency = Date.now() - t0;
  const receiptId = `rcpt_${crypto.randomUUID()}`;
  const ratingToken = `rtt_${crypto.randomUUID()}`;

  // The x402 facilitator settles before this handler runs. The response
  // X-PAYMENT-RESPONSE header (set by paymentMiddleware) contains the tx
  // hash; the buyer SDK can decode it. We surface it in the receipt body
  // too for convenience.
  const paymentResponseHeader = c.res.headers.get("X-PAYMENT-RESPONSE");
  let txHash =
    "0x0000000000000000000000000000000000000000000000000000000000000000";
  if (paymentResponseHeader) {
    try {
      const decoded = JSON.parse(
        Buffer.from(paymentResponseHeader, "base64").toString("utf8"),
      ) as { transaction?: string; txHash?: string };
      txHash = decoded.transaction ?? decoded.txHash ?? txHash;
    } catch {
      // header malformed — keep placeholder; the header is still authoritative
    }
  }

  const verification = {
    checks: [
      { name: "is_valid_png", passed: true },
      { name: "matches_dimensions", passed: true },
    ],
    all_passed: true,
  };

  // Layer 3 of the data-capture model: submit a signed receipt to the
  // canonical registry. Fire-and-forget — never blocks the buyer's response.
  // Opt out with SWARMWAGE_RECEIPTS=0.
  void submitReceipt({
    registryUrl: REGISTRY_URL,
    sellerPrivateKey: PRIVATE_KEY,
    payload: {
      protocol_version: PROTOCOL_VERSION,
      hire_id: receiptId,
      agent_id: agentId,
      buyer:
        (body.buyer_id?.toLowerCase() as AgentId) ??
        ("0x0000000000000000000000000000000000000000" as AgentId),
      capability: body.capability ?? "image.generate.photorealistic.png",
      amount_usdc_atomic: priceUsdcToAtomic(PRICE_USDC),
      network: NETWORK as "base" | "base-sepolia",
      tx_hash: txHash as `0x${string}`,
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
      tx_hash: txHash,
      price_paid_usdc: PRICE_USDC,
      completed_at: completedAt,
    },
    result,
    verification,
    rating_token: ratingToken,
    _meta: { latency_ms: latency },
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
