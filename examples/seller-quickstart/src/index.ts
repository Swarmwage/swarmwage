// Swarmwage seller QUICKSTART — wrap an existing HTTP API as a paid agent.
// License: MIT

import type { Hex } from "@swarmwage/agent-sdk";
import { createSellerRuntime } from "@swarmwage/example-seller-runtime";
import type { Network } from "x402-hono";

const PRIVATE_KEY = process.env.SELLER_PRIVATE_KEY as Hex | undefined;
if (!PRIVATE_KEY) {
  process.stderr.write(
    "seller-quickstart: SELLER_PRIVATE_KEY required (0x-prefixed 32-byte hex).\n" +
      "This is the wallet that RECEIVES USDC. Keep it secret.\n",
  );
  process.exit(1);
}
const CAPABILITY = process.env.CAPABILITY;
if (!CAPABILITY) {
  process.stderr.write(
    "seller-quickstart: CAPABILITY required (e.g. research.scrape.json or custom.brand.name).\n",
  );
  process.exit(1);
}
const UPSTREAM_URL = process.env.UPSTREAM_URL;
if (!UPSTREAM_URL) {
  process.stderr.write(
    "seller-quickstart: UPSTREAM_URL required (the existing API this wrapper forwards to).\n",
  );
  process.exit(1);
}

const PORT = Number(process.env.PORT ?? 4010);
const REGISTRY_URL = process.env.REGISTRY_URL ?? "https://api.swarmwage.com";
const PUBLIC_URL = process.env.PUBLIC_URL ?? `http://localhost:${PORT}`;
const PRICE_USDC = process.env.PRICE_USDC ?? "0.02";
const MAX_LATENCY_MS = Number(process.env.MAX_LATENCY_MS ?? 15_000);
const FIRST_CALL_FREE = process.env.FIRST_CALL_FREE !== "0";
const NETWORK = (process.env.NETWORK ?? "base") as Network;
const FACILITATOR_URL = (process.env.FACILITATOR_URL ??
  "https://facilitator.swarmwage.com") as `${string}://${string}`;
const UPSTREAM_METHOD = (process.env.UPSTREAM_METHOD ?? "POST").toUpperCase();
const UPSTREAM_AUTH_HEADER = process.env.UPSTREAM_AUTH_HEADER;
const UPSTREAM_AUTH_VALUE = process.env.UPSTREAM_AUTH_VALUE;
const UPSTREAM_TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS ?? 30_000);
const HIRE_RATE_LIMIT_PER_IP = Number(process.env.HIRE_RATE_LIMIT_PER_IP ?? 20);
const HIRE_RATE_WINDOW_MS = Number(process.env.HIRE_RATE_WINDOW_MS ?? 60_000);
const MAX_DAILY_HIRES = Number(process.env.MAX_DAILY_HIRES ?? 1000);
const MAX_DAILY_SPEND_USD = Number(process.env.MAX_DAILY_SPEND_USD ?? 50);
const EST_UPSTREAM_USD_PER_CALL = Number(
  process.env.EST_UPSTREAM_USD_PER_CALL ?? 0.001,
);

async function callUpstream(params: unknown) {
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
    const response = await fetch(UPSTREAM_URL!, {
      method: UPSTREAM_METHOD === "GET" ? "GET" : "POST",
      headers,
      body:
        UPSTREAM_METHOD === "GET" ? undefined : JSON.stringify(params),
      signal: controller.signal,
    });
    const text = await response.text();
    let result: unknown = text;
    try {
      result = JSON.parse(text);
    } catch {
      result = { raw: text };
    }
    return { result, ok: response.ok, status: response.status };
  } finally {
    clearTimeout(timer);
  }
}

const runtime = createSellerRuntime({
  identity: { privateKey: PRIVATE_KEY, serviceName: "seller-quickstart" },
  listing: {
    capability: CAPABILITY,
    priceUsdc: PRICE_USDC,
    maxLatencyMs: MAX_LATENCY_MS,
    firstCallFree: FIRST_CALL_FREE,
    publicUrl: PUBLIC_URL,
    registryUrl: REGISTRY_URL,
    publishedMessage: `seller-quickstart: listing published (capability=${CAPABILITY}, price=${PRICE_USDC} USDC, endpoint=${PUBLIC_URL})\n`,
  },
  payment: {
    network: NETWORK,
    facilitatorUrl: FACILITATOR_URL,
    validateSettlementHash: true,
  },
  limits: {
    perIp: HIRE_RATE_LIMIT_PER_IP,
    windowMs: HIRE_RATE_WINDOW_MS,
    maxDailyHires: MAX_DAILY_HIRES,
    maxDailySpendUsd: MAX_DAILY_SPEND_USD,
    estimatedUpstreamUsd: EST_UPSTREAM_USD_PER_CALL,
  },
  metadata: {
    network: NETWORK,
    price_usdc: PRICE_USDC,
    upstream: "configured",
  },
  async fulfill(params, c) {
    let upstream: Awaited<ReturnType<typeof callUpstream>>;
    try {
      upstream = await callUpstream(params ?? {});
    } catch (error) {
      process.stderr.write(
        `seller-quickstart: upstream call failed — ${(error as Error).message}\n`,
      );
      return c.json(
        { error: `Upstream failed: ${(error as Error).message}` },
        502,
      );
    }
    if (!upstream.ok) {
      return c.json(
        {
          error: `Upstream returned HTTP ${upstream.status}`,
          result: upstream.result,
        },
        502,
      );
    }
    const nonEmpty =
      upstream.result != null &&
      !(
        typeof upstream.result === "object" &&
        Object.keys(upstream.result as object).length === 0
      );
    return {
      result: upstream.result,
      verification: {
        checks: [
          { name: "upstream_2xx", passed: true },
          { name: "non_empty_result", passed: nonEmpty },
        ],
        all_passed: nonEmpty,
      },
    };
  },
});

void runtime.start(
  PORT,
  `seller-quickstart v0.0.1 listening on ${PUBLIC_URL} (agent_id=${runtime.agentId}, capability=${CAPABILITY})\n`,
);
