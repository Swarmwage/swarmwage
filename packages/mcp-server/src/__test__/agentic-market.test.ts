// Swarmwage MCP — Agentic Market catalog client tests
// License: MIT

import { test } from "node:test";
import assert from "node:assert/strict";

import { searchAgenticMarketServices } from "../agentic-market.js";

test("searchAgenticMarketServices returns only safe fixed-price Base USDC endpoints by default", async () => {
  let requestedUrl = "";
  const fetchImpl = async (url: URL | RequestInfo) => {
    requestedUrl = String(url);
    return new Response(
      JSON.stringify({
        total: 4,
        services: [
          {
            id: "exa-ai",
            name: "Exa",
            description: "AI-powered web search",
            domain: "exa.ai",
            providerUrl: "https://exa.ai",
            category: "Search",
            integrationType: "1P",
            endpoints: [
              {
                url: "https://api.exa.ai/search",
                method: "POST",
                description: "Search the web",
                pricing: {
                  amount: "0.007",
                  currency: "USDC",
                  network: "Base",
                  scheme: "exact",
                },
                parameters: [
                  {
                    group: "body",
                    name: "query",
                    type: "string",
                    description: "Search query",
                    required: true,
                    example: "swarmwage",
                  },
                ],
                quality: {
                  l30DaysTotalCalls: "2287",
                  l30DaysUniquePayers: "107",
                },
              },
              {
                url: "https://api.exa.ai/search-dynamic",
                method: "POST",
                pricing: {
                  amount: "0.007",
                  currency: "USDC",
                  network: "Base",
                  scheme: "upto",
                  maxAmount: "0.015",
                },
              },
            ],
          },
          {
            id: "solana-only",
            name: "Solana Search",
            category: "Search",
            endpoints: [
              {
                url: "https://sol.example/search",
                method: "POST",
                pricing: {
                  amount: "0.001",
                  currency: "USDC",
                  network: "Solana",
                  scheme: "exact",
                },
              },
            ],
          },
          {
            id: "expensive",
            name: "Expensive Search",
            category: "Search",
            endpoints: [
              {
                url: "https://expensive.example/search",
                method: "POST",
                pricing: {
                  amount: "1.00",
                  currency: "USDC",
                  network: "Base",
                  scheme: "exact",
                },
              },
            ],
          },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };

  const res = await searchAgenticMarketServices(
    {
      query: "exa",
      category: "Search",
      max_price_usdc: "0.02",
      limit: 10,
    },
    { fetchImpl: fetchImpl as typeof fetch },
  );

  assert.match(requestedUrl, /^https:\/\/api\.agentic\.market\/v1\/services\/search/);
  assert.match(requestedUrl, /q=exa/);
  assert.equal(res.endpoints.length, 1);
  assert.equal(res.endpoints[0]!.service_name, "Exa");
  assert.equal(res.endpoints[0]!.endpoint.url, "https://api.exa.ai/search");
  assert.equal(res.endpoints[0]!.endpoint.pricing.scheme, "exact");
  assert.equal(res.endpoints[0]!.endpoint.quality?.last_30d_calls, 2287);
  assert.equal(res.endpoints[0]!.endpoint.parameters[0]!.name, "query");
  assert.deepEqual(res.endpoints[0]!.call_hint, {
    tool: "call_x402_service",
    url: "https://api.exa.ai/search",
    method: "POST",
    max_price_usdc: "0.007",
    source: "agentic.market",
    service_id: "exa-ai",
    service_name: "Exa",
    endpoint_description: "Search the web",
    category: "Search",
    pricing_scheme: "exact",
  });
});

test("searchAgenticMarketServices can include dynamic upto pricing when explicitly requested", async () => {
  const fetchImpl = async () =>
    new Response(
      JSON.stringify({
        total: 1,
        services: [
          {
            id: "exa-ai",
            name: "Exa",
            category: "Search",
            endpoints: [
              {
                url: "https://api.exa.ai/search",
                method: "POST",
                pricing: {
                  amount: "0.007",
                  maxAmount: "0.015",
                  minAmount: "0.007",
                  currency: "USDC",
                  network: "Base",
                  scheme: "upto",
                },
              },
            ],
          },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );

  const res = await searchAgenticMarketServices(
    { query: "exa", include_dynamic_pricing: true },
    { fetchImpl: fetchImpl as typeof fetch },
  );

  assert.equal(res.filters.pricing_scheme, "exact+dynamic");
  assert.equal(res.endpoints.length, 1);
  assert.equal(res.endpoints[0]!.call_hint.max_price_usdc, "0.015");
  assert.equal(res.endpoints[0]!.call_hint.pricing_scheme, "upto");
});
