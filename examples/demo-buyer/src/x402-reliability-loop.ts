// Swarmwage buyer demo — mock external x402 reliability loop
// License: MIT
//
// Repeatable no-spend loop:
//   registry search -> external x402 call -> reliability evidence -> registry read

import { generatePrivateKey } from "viem/accounts";
import { AgentClient, type Hex } from "@swarmwage/agent-sdk";

const REGISTRY_URL = process.env.REGISTRY_URL ?? "https://registry.mock";
const EXTERNAL_X402_URL =
  process.env.EXTERNAL_X402_URL ?? "https://x402.mock/search";
const CAPABILITY = "custom.external-x402.mock";

function installMockFetch(): () => void {
  const original = globalThis.fetch;
  const records: Array<Record<string, unknown>> = [];

  globalThis.fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const req = input instanceof Request ? input : new Request(input, init);
    const parsedUrl = new URL(req.url);
    const bodyText = await req.clone().text();
    const body = bodyText ? (JSON.parse(bodyText) as Record<string, unknown>) : {};

    if (req.url === `${REGISTRY_URL}/v1/search`) {
      return json({
        agents: [
          {
            agent_id: "0x00000000000000000000000000000000000000e1",
            listing: {
              capability: CAPABILITY,
              price_usdc: "0.00",
              currency: "USDC",
              chain: "base",
              max_latency_ms: 1000,
              first_call_free: true,
              endpoint: EXTERNAL_X402_URL,
            },
            reputation: {
              success_rate: 1,
              avg_latency_ms: 120,
              last_30d_hire_count: 1,
              avg_stars: 5,
              total_ratings: 1,
              claimed: false,
            },
          },
        ],
        next_cursor: null,
        match: "exact",
      });
    }

    if (req.url === EXTERNAL_X402_URL) {
      return json({
        ok: true,
        provider: "mock-x402-service",
        echo: body,
      });
    }

    if (
      parsedUrl.origin === REGISTRY_URL &&
      parsedUrl.pathname === "/v1/reliability/external-x402"
    ) {
      if (req.method === "POST") {
        records.push(body);
        return json({
          ok: true,
          reliability_record_id: "rel_mock_001",
          trust_level: "client_observed",
        });
      }

      const latest = records.at(-1);
      return json({
        trust_level: "client_observed",
        count: latest ? 1 : 0,
        services: latest
          ? [
              {
                trust_level: "client_observed",
                source: latest.source,
                service_id: latest.service_id,
                service_name: latest.service_name,
                category: latest.category,
                endpoint_description: latest.endpoint_description,
                pricing_scheme: latest.pricing_scheme,
                url: latest.url,
                method: latest.method,
                calls: 1,
                paid_calls: latest.amount_paid_usdc ? 1 : 0,
                success_rate: 1,
                final_status_counts: { "200": 1 },
                latency_ms: { p50: latest.latency_ms, p95: latest.latency_ms },
                last_call_ts: latest.ts,
                verifier_counts: { unknown: 1, pass: 0, fail: 0 },
                tx_hash_coverage: latest.tx_hash ? 1 : 0,
              },
            ]
          : [],
        note:
          "External x402 services are third-party endpoints, not Swarmwage sellers. These aggregates are client-observed reliability evidence, not seller-signed receipts or guarantees.",
      });
    }

    throw new Error(`mock fetch: unmatched ${req.method} ${req.url}`);
  }) as typeof fetch;

  return () => void (globalThis.fetch = original);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function main(): Promise<void> {
  const restore = installMockFetch();
  try {
    const client = new AgentClient({
      privateKey:
        (process.env.BUYER_PRIVATE_KEY as Hex | undefined) ??
        generatePrivateKey(),
      registryUrl: REGISTRY_URL,
      telemetry: false,
      reliability: true,
    });

    const search = await client.search({
      capability: CAPABILITY,
      limit: 1,
    });

    const paidCall = await client.payX402({
      url: EXTERNAL_X402_URL,
      method: "POST",
      body: { query: "swarmwage reliability loop" },
      max_price_usdc: "0.01",
      source: "mock",
      service_id: "mock-search",
      service_name: "Mock Search",
      endpoint_description: "Mock x402 search endpoint",
      category: "Search",
      pricing_scheme: "exact",
    });

    const reliability = await client.getExternalX402Reliability({
      source: "mock",
      service_id: "mock-search",
      url: EXTERNAL_X402_URL,
      limit: 1,
    });

    process.stdout.write(
      `${JSON.stringify(
        {
          search_count: search.length,
          called_url: paidCall.url,
          status: paidCall.status,
          amount_paid_usdc: paidCall.amount_paid_usdc ?? null,
          tx_hash: paidCall.tx_hash ?? null,
          reliability_record_id: paidCall.reliability_record_id,
          request_hash: paidCall.request_hash,
          response_hash: paidCall.response_hash,
          reliability,
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    restore();
  }
}

main().catch((err) => {
  process.stderr.write(`x402 reliability loop failed: ${(err as Error).message}\n`);
  process.exit(1);
});
