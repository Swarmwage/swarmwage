// Swarmwage MCP — CallTool dispatch tests
// License: MIT
//
// First test coverage for the MCP server (the primary distribution
// surface). The dispatch is exercised directly via createToolHandler with
// mocked deps — no stdio transport, no live registry, no wallet file.

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  InsufficientFundsError,
  type AgentClient,
  type AgentId,
  type ExternalX402ReliabilityResponse,
  type Reputation,
  type SearchResponse,
} from "@swarmwage/agent-sdk";

import type { AgenticMarketSearchResponse } from "../agentic-market.js";
import { createToolHandler, type ToolHandlerDeps } from "../handlers.js";
import { tools } from "../tools.js";

const AGENT = "0x00000000000000000000000000000000000000a1" as AgentId;

const SAMPLE_REPUTATION: Reputation = {
  agent_id: AGENT,
  success_rate: 0.99,
  avg_latency_ms: 800,
  avg_cost_per_capability: {},
  last_24h_volume_usdc: "1.00",
  last_30d_hire_count: 12,
  total_ratings: 4,
  avg_stars: 5,
  claimed: true,
};

const EMPTY_SEARCH: SearchResponse = {
  agents: [],
  next_cursor: null,
  match: "exact",
  available_capabilities: ["code.execute.sandboxed", "image.generate.photorealistic.png"],
  total_distinct_capabilities: 2,
};

const EXTERNAL_X402_SEARCH: AgenticMarketSearchResponse = {
  source: "agentic.market",
  query: "exa",
  total_services_reported: 1,
  scanned_services: 1,
  filters: {
    network: "Base",
    currency: "USDC",
    pricing_scheme: "exact",
    max_price_usdc: "0.02",
  },
  note: "external",
  endpoints: [
    {
      source: "agentic.market",
      service_id: "exa-ai",
      service_name: "Exa",
      service_description: "AI-powered web search",
      category: "Search",
      domain: "exa.ai",
      provider_url: "https://exa.ai",
      integration_type: "1P",
      endpoint: {
        url: "https://api.exa.ai/search",
        method: "POST",
        description: "Search the web",
        pricing: {
          amount_usdc: "0.007",
          scheme: "exact",
          network: "Base",
          currency: "USDC",
        },
        parameters: [
          {
            group: "body",
            name: "query",
            type: "string",
            description: "",
            required: false,
          },
        ],
        quality: {
          last_30d_calls: 2287,
          last_30d_unique_payers: 107,
        },
      },
      call_hint: {
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
      },
    },
  ],
};

const EXTERNAL_X402_RELIABILITY: ExternalX402ReliabilityResponse = {
  trust_level: "client_observed",
  count: 1,
  note:
    "External x402 services are third-party endpoints, not Swarmwage sellers. These aggregates are client-observed reliability evidence, not seller-signed receipts or guarantees.",
  services: [
    {
      trust_level: "client_observed",
      source: "agentic.market",
      service_id: "exa-ai",
      service_name: "Exa",
      category: "Search",
      endpoint_description: "Search the web",
      pricing_scheme: "exact",
      url: "https://api.exa.ai/search",
      method: "POST",
      calls: 3,
      paid_calls: 2,
      success_rate: 2 / 3,
      final_status_counts: { "200": 2, "500": 1 },
      latency_ms: { p50: 120, p95: 240 },
      last_call_ts: 1_719_000_000_000,
      verifier_counts: { unknown: 3, pass: 0, fail: 0 },
      tx_hash_coverage: 2 / 3,
    },
  ],
};

function makeDeps(overrides: Partial<ToolHandlerDeps> = {}): ToolHandlerDeps {
  return {
    // Lookup-only by default — the most common cold-install state.
    ensureClient: async () => undefined,
    directSearch: async () => EMPTY_SEARCH,
    directReputation: async () => SAMPLE_REPUTATION,
    searchExternalX402Services: async () => EXTERNAL_X402_SEARCH,
    directExternalX402Reliability: async () => EXTERNAL_X402_RELIABILITY,
    ...overrides,
  };
}

function parseText(result: { content: Array<{ text: string }> }): unknown {
  return JSON.parse(result.content[0]!.text);
}

describe("search_agents", () => {
  test("returns agents from directSearch on a hit", async () => {
    const hit: SearchResponse = {
      agents: [
        {
          agent_id: AGENT,
          listing: {
            capability: "code.execute.sandboxed",
            price_usdc: "0.05",
            currency: "USDC",
            chain: "base",
            max_latency_ms: 5000,
            first_call_free: false,
            endpoint: "https://seller.example",
          },
          reputation: {
            success_rate: 1,
            avg_latency_ms: 500,
            last_30d_hire_count: 3,
            avg_stars: 5,
            total_ratings: 2,
            claimed: false,
          },
        },
      ] as SearchResponse["agents"],
      next_cursor: null,
      match: "exact",
    };
    const handler = createToolHandler(
      makeDeps({ directSearch: async () => hit }),
    );
    const res = await handler({
      name: "search_agents",
      arguments: { capability: "code.execute.sandboxed" },
    });
    assert.ok(!res.isError);
    const body = parseText(res) as { agents: unknown[] };
    assert.equal(body.agents.length, 1);
  });

  test("empty result carries available_capabilities + retry hint", async () => {
    const handler = createToolHandler(makeDeps());
    const res = await handler({
      name: "search_agents",
      arguments: { capability: "code.execute.python.sandbox" },
    });
    assert.ok(!res.isError);
    const body = parseText(res) as {
      agents: unknown[];
      available_capabilities: string[];
      total_distinct_capabilities: number;
      hint: string;
    };
    assert.equal(body.agents.length, 0);
    assert.deepEqual(body.available_capabilities, EMPTY_SEARCH.available_capabilities);
    assert.equal(body.total_distinct_capabilities, 2);
    assert.match(body.hint, /do not guess variants/);
  });
});

describe("list_capabilities", () => {
  test("queries the sentinel capability and maps the taxonomy fields", async () => {
    let seenCapability = "";
    const handler = createToolHandler(
      makeDeps({
        directSearch: async (req) => {
          seenCapability = req.capability;
          return EMPTY_SEARCH;
        },
      }),
    );
    const res = await handler({ name: "list_capabilities", arguments: {} });
    assert.equal(seenCapability, "__list_capabilities__");
    const body = parseText(res) as { capabilities: string[]; total: number };
    assert.deepEqual(body.capabilities, EMPTY_SEARCH.available_capabilities);
    assert.equal(body.total, 2);
  });
});

describe("search_x402_services", () => {
  test("searches external x402 services without requiring a wallet", async () => {
    let seen: Record<string, unknown> | null = null;
    const handler = createToolHandler(
      makeDeps({
        searchExternalX402Services: async (req) => {
          seen = req as unknown as Record<string, unknown>;
          return EXTERNAL_X402_SEARCH;
        },
      }),
    );

    const res = await handler({
      name: "search_x402_services",
      arguments: {
        query: "exa",
        category: "Search",
        max_price_usdc: "0.02",
        limit: 5,
      },
    });

    assert.ok(!res.isError);
    assert.deepEqual(seen, {
      query: "exa",
      category: "Search",
      max_price_usdc: "0.02",
      limit: 5,
      include_dynamic_pricing: false,
    });
    const body = parseText(res) as AgenticMarketSearchResponse;
    assert.equal(body.endpoints[0]!.source, "agentic.market");
    assert.equal(body.endpoints[0]!.call_hint.tool, "call_x402_service");
  });

  test("does not load the wallet for read-only external discovery", async () => {
    const handler = createToolHandler(
      makeDeps({
        ensureClient: async () => {
          throw new Error("wallet load should not run");
        },
      }),
    );

    const res = await handler({
      name: "search_x402_services",
      arguments: { query: "exa" },
    });

    assert.ok(!res.isError);
    const body = parseText(res) as AgenticMarketSearchResponse;
    assert.equal(body.endpoints.length, 1);
  });
});

describe("call_x402_service dry-run", () => {
  test("returns a no-spend plan without loading a wallet", async () => {
    const handler = createToolHandler(
      makeDeps({
        ensureClient: async () => {
          throw new Error("wallet load should not run");
        },
      }),
    );

    const res = await handler({
      name: "call_x402_service",
      arguments: {
        dry_run: true,
        url: "https://api.exa.ai/search",
        method: "POST",
        body: { query: "swarmwage" },
        max_price_usdc: "0.02",
        source: "agentic.market",
        service_id: "exa-ai",
        service_name: "Exa",
        endpoint_description: "Search the web",
        category: "Search",
        pricing_scheme: "exact",
      },
    });

    assert.ok(!res.isError);
    const body = parseText(res) as {
      dry_run: boolean;
      requires_wallet_for_real_call: boolean;
      would_call: {
        url: string;
        method: string;
        max_price_usdc: string;
        trust_level: string;
        trust_note: string;
      };
      next_step: string;
    };
    assert.equal(body.dry_run, true);
    assert.equal(body.requires_wallet_for_real_call, true);
    assert.equal(body.would_call.url, "https://api.exa.ai/search");
    assert.equal(body.would_call.method, "POST");
    assert.equal(body.would_call.max_price_usdc, "0.02");
    assert.equal(body.would_call.trust_level, "client_observed");
    assert.match(body.would_call.trust_note, /does not call the endpoint/);
    assert.match(body.next_step, /funded wallet/);
  });
});

describe("get_x402_service_reliability", () => {
  test("reads client-observed external x402 reliability without requiring a wallet", async () => {
    let seen: Record<string, unknown> | null = null;
    const handler = createToolHandler(
      makeDeps({
        ensureClient: async () => {
          throw new Error("wallet load should not run");
        },
        directExternalX402Reliability: async (req) => {
          seen = req as unknown as Record<string, unknown>;
          return EXTERNAL_X402_RELIABILITY;
        },
      }),
    );

    const res = await handler({
      name: "get_x402_service_reliability",
      arguments: {
        source: "agentic.market",
        service_id: "exa-ai",
        url: "https://api.exa.ai/search",
        limit: 5,
      },
    });

    assert.ok(!res.isError);
    assert.deepEqual(seen, {
      source: "agentic.market",
      service_id: "exa-ai",
      url: "https://api.exa.ai/search",
      limit: 5,
    });
    const body = parseText(res) as ExternalX402ReliabilityResponse;
    assert.equal(body.trust_level, "client_observed");
    assert.match(body.note, /not seller-signed receipts/);
    assert.equal(body.services[0]!.tx_hash_coverage, 2 / 3);
  });
});

describe("lookup-only mode (no wallet)", () => {
  test("check_reputation falls back to directReputation", async () => {
    let called = false;
    const handler = createToolHandler(
      makeDeps({
        directReputation: async () => {
          called = true;
          return SAMPLE_REPUTATION;
        },
      }),
    );
    const res = await handler({
      name: "check_reputation",
      arguments: { agent_id: AGENT },
    });
    assert.ok(called, "must use the direct registry fetch when no client");
    const body = parseText(res) as Reputation;
    assert.equal(body.agent_id, AGENT);
  });

  test("get_remaining_budget returns '0.00' and get_agent_id returns null", async () => {
    const handler = createToolHandler(makeDeps());
    const budget = parseText(
      await handler({ name: "get_remaining_budget", arguments: {} }),
    ) as { remaining_usdc: string };
    assert.equal(budget.remaining_usdc, "0.00");
    const id = parseText(
      await handler({ name: "get_agent_id", arguments: {} }),
    ) as { agent_id: string | null };
    assert.equal(id.agent_id, null);
  });

  for (const name of [
    "hire_agent",
    "rate_agent",
    "publish_listing",
    "update_listing",
    "list_my_listings",
    "get_my_receipts",
    "call_x402_service",
  ]) {
    test(`${name} returns the wallet-required error`, async () => {
      const handler = createToolHandler(makeDeps());
      const res = await handler({ name, arguments: {} });
      assert.equal(res.isError, true);
      assert.match(res.content[0]!.text, /requires a wallet/);
      assert.match(res.content[0]!.text, /lookup-only mode/);
      assert.match(res.content[0]!.text, /get_x402_service_reliability/);
    });
  }
});

describe("wallet mode", () => {
  test("check_reputation prefers the SDK client over directReputation", async () => {
    let directCalled = false;
    const client = {
      getReputation: async () => SAMPLE_REPUTATION,
    } as unknown as AgentClient;
    const handler = createToolHandler(
      makeDeps({
        ensureClient: async () => client,
        directReputation: async () => {
          directCalled = true;
          return SAMPLE_REPUTATION;
        },
      }),
    );
    await handler({ name: "check_reputation", arguments: { agent_id: AGENT } });
    assert.equal(directCalled, false);
  });

  test("hire_agent formats InsufficientFundsError as an actionable funding instruction", async () => {
    const client = {
      hire: async () => {
        throw new InsufficientFundsError(AGENT, "0.10", "base");
      },
    } as unknown as AgentClient;
    const handler = createToolHandler(
      makeDeps({ ensureClient: async () => client }),
    );
    const res = await handler({
      name: "hire_agent",
      arguments: { capability: "code.execute.sandboxed", params: {}, max_price_usdc: "0.10" },
    });
    assert.equal(res.isError, true);
    const text = res.content[0]!.text;
    assert.match(text, /fund .* with at least 0\.10 USDC/i);
    assert.match(text, /Do NOT substitute/);
    assert.match(text, /call hire_agent again/);
  });

  test("generic client errors surface message (and code when present)", async () => {
    const failure = Object.assign(new Error("registry search failed: 503"), {
      code: "E503",
    });
    const client = {
      getMyListings: async () => {
        throw failure;
      },
    } as unknown as AgentClient;
    const handler = createToolHandler(
      makeDeps({ ensureClient: async () => client }),
    );
    const res = await handler({ name: "list_my_listings", arguments: {} });
    assert.equal(res.isError, true);
    assert.match(res.content[0]!.text, /^\[E503\] registry search failed: 503/);
  });

  test("call_x402_service passes external catalog metadata to the SDK", async () => {
    let seen: Record<string, unknown> | null = null;
    const client = {
      payX402: async (req: Record<string, unknown>) => {
        seen = req;
        return {
          url: req.url,
          status: 200,
          data: { ok: true },
          amount_paid_usdc: "0.01",
          latency_ms: 12,
        };
      },
      remainingBudget: () => "0.99",
    } as unknown as AgentClient;
    const handler = createToolHandler(
      makeDeps({ ensureClient: async () => client }),
    );

    const res = await handler({
      name: "call_x402_service",
      arguments: {
        url: "https://api.exa.ai/search",
        method: "POST",
        body: { query: "swarmwage" },
        max_price_usdc: "0.02",
        source: "agentic.market",
        service_id: "exa-ai",
        service_name: "Exa",
        endpoint_description: "Search the web",
        category: "Search",
        pricing_scheme: "exact",
      },
    });

    assert.ok(!res.isError);
    const body = parseText(res) as {
      trust_level: string;
      trust_note: string;
      reliability_record_id?: string;
    };
    assert.equal(body.trust_level, "client_observed");
    assert.match(body.trust_note, /not a seller-signed Swarmwage receipt/);
    assert.deepEqual(seen, {
      url: "https://api.exa.ai/search",
      method: "POST",
      body: { query: "swarmwage" },
      headers: undefined,
      source: "agentic.market",
      service_id: "exa-ai",
      service_name: "Exa",
      endpoint_description: "Search the web",
      category: "Search",
      pricing_scheme: "exact",
      max_price_usdc: "0.02",
    });
  });
});

describe("tool catalog", () => {
  test("unknown tool name returns an error result", async () => {
    const handler = createToolHandler(makeDeps());
    const res = await handler({ name: "definitely_not_a_tool", arguments: {} });
    assert.equal(res.isError, true);
    assert.match(res.content[0]!.text, /Unknown tool/);
  });

  test("every dispatched tool exists in the published catalog (and vice versa)", () => {
    // Keeps tools.ts and handlers.ts from drifting apart: a tool advertised
    // but not dispatched returns 'Unknown tool' to real users.
    const advertised = new Set(tools.map((t) => t.name));
    const dispatched = [
      "search_agents",
      "hire_agent",
      "check_reputation",
      "rate_agent",
      "get_remaining_budget",
      "get_agent_id",
      "publish_listing",
      "update_listing",
      "list_my_listings",
      "get_my_receipts",
      "list_capabilities",
      "search_x402_services",
      "get_x402_service_reliability",
      "call_x402_service",
    ];
    for (const name of dispatched) {
      assert.ok(advertised.has(name), `tool '${name}' missing from catalog`);
    }
    assert.equal(advertised.size, dispatched.length);
  });
});
