// Swarmwage buyer demo — LIVE external x402 reliability seed (REAL on-chain spend)
// License: MIT
//
// Real counterpart of x402-reliability-loop.ts (which is fully mocked / no-spend).
// Makes a REAL x402 payment to a third-party endpoint; the SDK then submits a
// client-observed reliability record to the live registry and we read it back.
//
// THIS SPENDS USDC ON BASE MAINNET. Requires BUYER_PRIVATE_KEY (funded wallet).
//
// Run (real spend):
//   cd examples/demo-buyer
//   pnpm x402:live                       # default: BlockRun GET, cap 0.005 USDC
//
// Override target via env (all optional, isolated from the demo's own env):
//   X402_URL, X402_METHOD, X402_MAX_PRICE, X402_BODY (JSON string),
//   X402_SOURCE, X402_SERVICE_ID, X402_SERVICE_NAME, X402_DESC, X402_CATEGORY,
//   X402_NETWORK (default "base"), X402_REGISTRY_URL (default api.swarmwage.com).

import { AgentClient, type Hex } from "@swarmwage/agent-sdk";

const URL_ = process.env.X402_URL ?? "https://blockrun.ai/api/v1/defillama/chains";
const METHOD = (process.env.X402_METHOD ?? "GET").toUpperCase();
const MAX_PRICE = process.env.X402_MAX_PRICE ?? "0.005";
const NETWORK = (process.env.X402_NETWORK ?? "base") as "base" | "base-sepolia";
const REGISTRY_URL = process.env.X402_REGISTRY_URL ?? "https://api.swarmwage.com";
const BODY = process.env.X402_BODY ? JSON.parse(process.env.X402_BODY) : undefined;

async function main(): Promise<void> {
  const key = process.env.BUYER_PRIVATE_KEY as Hex | undefined;
  if (!key) {
    throw new Error(
      "BUYER_PRIVATE_KEY is required for a real spend — refusing to generate a throwaway key.",
    );
  }

  const client = new AgentClient({
    privateKey: key,
    registryUrl: REGISTRY_URL,
    network: NETWORK,
    telemetry: false,
    reliability: true,
  });

  console.error(
    `[seed] ${METHOD} ${URL_}  cap=${MAX_PRICE} USDC  network=${NETWORK}  registry=${REGISTRY_URL}`,
  );

  const paid = await client.payX402({
    url: URL_,
    method: METHOD,
    body: BODY,
    max_price_usdc: MAX_PRICE,
    source: process.env.X402_SOURCE ?? "agentic.market",
    service_id: process.env.X402_SERVICE_ID ?? "blockrun",
    service_name: process.env.X402_SERVICE_NAME ?? "BlockRun.AI",
    endpoint_description: process.env.X402_DESC ?? "TVL by chain (DeFiLlama)",
    category: process.env.X402_CATEGORY ?? "Data",
    pricing_scheme: "exact",
  });

  const reliability = await client.getExternalX402Reliability({ url: URL_, limit: 1 });

  process.stdout.write(
    `${JSON.stringify(
      {
        called_url: paid.url,
        status: paid.status,
        amount_paid_usdc: paid.amount_paid_usdc ?? null,
        tx_hash: paid.tx_hash ?? null,
        latency_ms: paid.latency_ms,
        reliability_record_id: paid.reliability_record_id ?? null,
        request_hash: paid.request_hash ?? null,
        response_hash: paid.response_hash ?? null,
        reliability,
      },
      null,
      2,
    )}\n`,
  );
}

main().catch((err) => {
  process.stderr.write(`x402 live seed failed: ${(err as Error).message}\n`);
  process.exit(1);
});
