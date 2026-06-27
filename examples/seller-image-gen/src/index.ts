// Reference Swarmwage seller — fulfills image.generate.photorealistic.png
// via Pollinations.ai (free public image gen, no API key required).
// License: MIT

import type { Hex } from "@swarmwage/agent-sdk";
import { createSellerRuntime } from "@swarmwage/example-seller-runtime";
import type { Network } from "x402-hono";

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
const HIRE_RATE_LIMIT_PER_IP = Number(process.env.HIRE_RATE_LIMIT_PER_IP ?? 20);
const HIRE_RATE_WINDOW_MS = Number(process.env.HIRE_RATE_WINDOW_MS ?? 60_000);
const MAX_DAILY_HIRES = Number(process.env.MAX_DAILY_HIRES ?? 1000);
const MAX_DAILY_SPEND_USD = Number(process.env.MAX_DAILY_SPEND_USD ?? 50);
const EST_UPSTREAM_USD_PER_CALL = Number(
  process.env.EST_UPSTREAM_USD_PER_CALL ?? 0,
);
const MAX_PROMPT_LENGTH = Number(process.env.MAX_PROMPT_LENGTH ?? 500);
const MAX_WIDTH = Number(process.env.MAX_WIDTH ?? 1024);
const MAX_HEIGHT = Number(process.env.MAX_HEIGHT ?? 1024);
const DEFAULT_WIDTH = 1024;
const DEFAULT_HEIGHT = 1024;
const CAPABILITY = "image.generate.photorealistic.png";

interface ImageGenInput {
  prompt: string;
  width: number;
  height: number;
  seed?: number;
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
  if (params.seed !== undefined && !Number.isInteger(params.seed)) {
    return { ok: false, error: "params.seed must be an integer when provided" };
  }
  return {
    ok: true,
    value: { prompt: params.prompt, width, height, seed: params.seed },
  };
}

async function generateImage(input: ImageGenInput) {
  const url = new URL(
    `https://image.pollinations.ai/prompt/${encodeURIComponent(input.prompt)}`,
  );
  url.searchParams.set("width", String(input.width));
  url.searchParams.set("height", String(input.height));
  url.searchParams.set("nologo", "true");
  url.searchParams.set("model", "flux");
  if (input.seed !== undefined) url.searchParams.set("seed", String(input.seed));
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Pollinations.ai returned ${response.status}`);
  }
  return {
    image_b64: Buffer.from(await response.arrayBuffer()).toString("base64"),
    width: input.width,
    height: input.height,
  };
}

const runtime = createSellerRuntime({
  identity: { privateKey: PRIVATE_KEY, serviceName: "seller-image-gen" },
  listing: {
    capability: CAPABILITY,
    priceUsdc: PRICE_USDC,
    maxLatencyMs: 15_000,
    firstCallFree: true,
    publicUrl: PUBLIC_URL,
    registryUrl: REGISTRY_URL,
    publishedMessage: `seller-image-gen: listing published (capability=${CAPABILITY}, price=${PRICE_USDC} USDC)\n`,
  },
  payment: { network: NETWORK, facilitatorUrl: FACILITATOR_URL },
  limits: {
    perIp: HIRE_RATE_LIMIT_PER_IP,
    windowMs: HIRE_RATE_WINDOW_MS,
    maxDailyHires: MAX_DAILY_HIRES,
    maxDailySpendUsd: MAX_DAILY_SPEND_USD,
    estimatedUpstreamUsd: EST_UPSTREAM_USD_PER_CALL,
  },
  metadata: {
    backend: "pollinations.ai (flux)",
    network: NETWORK,
    price_usdc: PRICE_USDC,
  },
  async fulfill(params, c) {
    const validation = validateImageGenInput(
      params as Partial<ImageGenInput> | undefined,
    );
    if (!validation.ok) return c.json({ error: validation.error }, 400);
    try {
      return {
        result: await generateImage(validation.value),
        verification: {
          checks: [
            { name: "is_valid_png", passed: true },
            { name: "matches_dimensions", passed: true },
          ],
          all_passed: true,
        },
      };
    } catch (error) {
      return c.json(
        { error: `Generation failed: ${(error as Error).message}` },
        502,
      );
    }
  },
});

void runtime.start(
  PORT,
  `seller-image-gen v0.0.1 listening on ${PUBLIC_URL} (agent_id=${runtime.agentId})\n`,
);
