// © 2026 Swarmwage. MIT.
// Reference seller for research.linkedin.profile.enrich via Apify.

import type { Hex } from "@swarmwage/agent-sdk";
import { createSellerRuntime } from "@swarmwage/example-seller-runtime";
import type { Network } from "x402-hono";
import { z } from "zod";
import { enrichProfile, EnrichBackendError } from "./enrich.js";
import { verifyProfile } from "./verify.js";

const PRIVATE_KEY = process.env.SELLER_PRIVATE_KEY as Hex | undefined;
if (!PRIVATE_KEY) {
  process.stderr.write(
    "seller-linkedin-enrich: SELLER_PRIVATE_KEY required (0x-prefixed 32-byte hex)\n",
  );
  process.exit(1);
}
const APIFY_API_TOKEN = process.env.APIFY_API_TOKEN;
if (!APIFY_API_TOKEN) {
  process.stderr.write("seller-linkedin-enrich: APIFY_API_TOKEN required\n");
  process.exit(1);
}

const PORT = Number(process.env.PORT ?? 4006);
const REGISTRY_URL = process.env.REGISTRY_URL ?? "http://localhost:3000";
const PUBLIC_URL = process.env.PUBLIC_URL ?? `http://localhost:${PORT}`;
const PRICE_USDC = process.env.PRICE_USDC ?? "0.50";
const NETWORK = (process.env.NETWORK ?? "base-sepolia") as Network;
const FACILITATOR_URL = (process.env.FACILITATOR_URL ??
  "https://x402.org/facilitator") as `${string}://${string}`;
const HIRE_RATE_LIMIT_PER_IP = Number(process.env.HIRE_RATE_LIMIT_PER_IP ?? 20);
const HIRE_RATE_WINDOW_MS = Number(process.env.HIRE_RATE_WINDOW_MS ?? 60_000);
const MAX_DAILY_HIRES = Number(process.env.MAX_DAILY_HIRES ?? 500);
const MAX_DAILY_SPEND_USD = Number(process.env.MAX_DAILY_SPEND_USD ?? 25);
const EST_UPSTREAM_USD_PER_CALL = Number(
  process.env.EST_UPSTREAM_USD_PER_CALL ?? 0.05,
);
const APIFY_TIMEOUT_MS = Number(process.env.APIFY_TIMEOUT_MS ?? 90_000);
const MAX_PROFILE_URL_LEN = 256;
const CAPABILITY = "research.linkedin.profile.enrich";

const HireParams = z.object({
  profile_url: z
    .string()
    .max(MAX_PROFILE_URL_LEN, `profile_url must be <= ${MAX_PROFILE_URL_LEN} chars`)
    .regex(
      /^https:\/\/(?:www\.)?linkedin\.com\/in\/[A-Za-z0-9\-_%.]+\/?$/,
      "profile_url must be https://(www.)?linkedin.com/in/<slug>",
    ),
});

class UnsafeUrl extends Error {}

function assertLinkedInUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeUrl("invalid URL");
  }
  if (url.protocol !== "https:") {
    throw new UnsafeUrl(`unsupported protocol: ${url.protocol}`);
  }
  const host = url.hostname.toLowerCase();
  if (host !== "linkedin.com" && host !== "www.linkedin.com") {
    throw new UnsafeUrl(`host not allowed: ${host}`);
  }
  if (!url.pathname.toLowerCase().startsWith("/in/")) {
    throw new UnsafeUrl("path must start with /in/");
  }
  return url;
}

const runtime = createSellerRuntime({
  identity: { privateKey: PRIVATE_KEY, serviceName: "seller-linkedin-enrich" },
  listing: {
    capability: CAPABILITY,
    priceUsdc: PRICE_USDC,
    maxLatencyMs: 60_000,
    firstCallFree: true,
    publicUrl: PUBLIC_URL,
    registryUrl: REGISTRY_URL,
    publishedMessage: `seller-linkedin-enrich: listing published (capability=${CAPABILITY}, price=${PRICE_USDC} USDC)\n`,
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
    backend: "apify:apify/linkedin-profile-scraper",
    network: NETWORK,
    price_usdc: PRICE_USDC,
  },
  async fulfill(params, c) {
    const parsed = HireParams.safeParse(params);
    if (!parsed.success) {
      return c.json(
        {
          error: "params validation failed",
          issues: parsed.error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        },
        400,
      );
    }
    let enriched: Awaited<ReturnType<typeof enrichProfile>>;
    try {
      enriched = await enrichProfile({
        profileUrl: assertLinkedInUrl(parsed.data.profile_url).toString(),
        apifyApiToken: APIFY_API_TOKEN,
        apifyTimeoutMs: APIFY_TIMEOUT_MS,
      });
    } catch (error) {
      if (error instanceof UnsafeUrl) {
        return c.json({ error: `Refused URL: ${error.message}` }, 400);
      }
      if (error instanceof EnrichBackendError) {
        process.stderr.write(
          `seller-linkedin-enrich: backend failure (${error.stage}) — ${error.message}\n`,
        );
        return c.json(
          { error: `Enrichment failed: ${error.message}`, stage: error.stage },
          502,
        );
      }
      process.stderr.write(
        `seller-linkedin-enrich: enrichment failed — ${(error as Error).message}\n`,
      );
      return c.json(
        { error: `Enrichment failed: ${(error as Error).message}` },
        502,
      );
    }
    const verification = verifyProfile({ profile: enriched.profile });
    if (!verification.all_passed) {
      process.stderr.write(
        `seller-linkedin-enrich: verifier rejected output — ${JSON.stringify(verification.checks)}\n`,
      );
      return c.json(
        { error: "Backend output failed local verification", verification },
        502,
      );
    }
    return {
      result: { profile: enriched.profile },
      verification,
      meta: {
        backend_used: enriched.meta.backend_used,
        duration_ms: enriched.meta.duration_ms,
      },
    };
  },
});

void runtime.start(
  PORT,
  `seller-linkedin-enrich v0.0.1 listening on ${PUBLIC_URL} (agent_id=${runtime.agentId})\n`,
);
