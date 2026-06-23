// Swarmwage Agent SDK — AgentClient hire/hireAsync regression tests
// License: MIT
//
// Covers two bugs found in the 2026-06-12 architectural review:
//   1. hireAsync resolved the seller endpoint from the reputation response,
//      which has never carried an endpoint — every call threw. It must
//      resolve from /v1/agents/:id/listings instead.
//   2. hire() recorded budget spend only after verification passed, so a
//      seller that fails verification could drain the wallet past the
//      operator-authorized budget. Spend must be recorded as soon as the
//      response arrives — the x402 payment has already settled on-chain.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { AgentClient } from "../client.js";
import {
  HireRefusedError,
  VerificationFailedError,
} from "../errors.js";
import {
  PROTOCOL_VERSION,
  type AgentId,
  type BudgetToken,
  type Hex,
} from "../types.js";

// Well-known test key (anvil account #0) — never holds real funds.
const TEST_PRIVATE_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;

const SELLER = "0x00000000000000000000000000000000000000a1" as AgentId;
const SELLER_ENDPOINT = "https://seller.example";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

interface RecordedCall {
  url: string;
  method: string;
  body: unknown;
}

/**
 * Install a route-table fetch mock on globalThis. Must be installed BEFORE
 * the AgentClient is constructed: the client wraps globalThis.fetch at
 * construct/hire time. Returns the calls log and a restore function.
 */
function mockFetch(
  routes: Array<{
    match: (url: string, method: string) => boolean;
    respond: (call: RecordedCall) => Response;
  }>,
): { calls: RecordedCall[]; restore: () => void } {
  const original = globalThis.fetch;
  const calls: RecordedCall[] = [];
  globalThis.fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    // @x402/fetch (x402 v2) invokes the wrapped fetch with a single Request
    // object (`fetch(new Request(input, init))`), so the method/body live on
    // the Request, not in `init`. Handle both shapes.
    let url: string;
    let method: string;
    let bodyRaw: string | undefined;
    if (input instanceof Request) {
      url = input.url;
      method = input.method;
      bodyRaw = await input.clone().text();
    } else {
      url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as Request).url;
      method = init?.method ?? "GET";
      bodyRaw = typeof init?.body === "string" ? init.body : undefined;
    }
    const body = bodyRaw ? JSON.parse(bodyRaw) : undefined;
    const call: RecordedCall = { url, method, body };
    calls.push(call);
    const route = routes.find((r) => r.match(url, method));
    if (!route) {
      throw new Error(`mockFetch: unmatched ${method} ${url}`);
    }
    return route.respond(call);
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

function makeClient(opts: { budget?: BudgetToken } = {}): AgentClient {
  return new AgentClient({
    privateKey: TEST_PRIVATE_KEY,
    telemetry: false,
    budget: opts.budget,
  });
}

function makeBudget(maxUsdc: string): BudgetToken {
  return {
    agent_id: SELLER,
    max_amount_usdc: maxUsdc,
    max_duration_seconds: 3600,
    issued_at: Math.floor(Date.now() / 1000),
    signature: "0xdeadbeef" as Hex,
  };
}

const SELLER_LISTING = {
  agent_id: SELLER,
  capability: "custom.test.echo",
  price_usdc: "0.05",
  currency: "USDC",
  chain: "base",
  max_latency_ms: 5000,
  first_call_free: false,
  endpoint: SELLER_ENDPOINT,
  signature: "0xabc123",
};

const SELLER_SEARCH_ENTRY = {
  agent_id: SELLER,
  listing: SELLER_LISTING,
  reputation: {
    success_rate: 1,
    avg_latency_ms: 100,
    last_30d_hire_count: 5,
    avg_stars: 5,
    total_ratings: 3,
    claimed: false,
  },
};

const RECEIPT = {
  receipt_id: "r-1",
  buyer_id: "0x00000000000000000000000000000000000000b2",
  seller_id: SELLER,
  capability: "custom.test.echo",
  tx_hash:
    "0x1111111111111111111111111111111111111111111111111111111111111111",
  price_paid_usdc: "0.05",
  completed_at: Math.floor(Date.now() / 1000),
};

describe("hireAsync endpoint resolution", () => {
  test("resolves the seller endpoint from /v1/agents/:id/listings and POSTs the hire there", async (t) => {
    const { calls, restore } = mockFetch([
      {
        match: (url, method) =>
          url.includes(`/v1/agents/${SELLER}/listings`) && method === "GET",
        respond: () => jsonResponse({ listings: [SELLER_LISTING] }),
      },
      {
        match: (url, method) =>
          url === `${SELLER_ENDPOINT}/hire` && method === "POST",
        respond: () =>
          jsonResponse({
            protocol: PROTOCOL_VERSION,
            job_id: "job-42",
            estimated_completion_ms: 1000,
          }),
      },
    ]);
    t.after(restore);

    const client = makeClient();
    const res = await client.hireAsync({
      agent_id: SELLER,
      capability: "custom.test.echo",
      params: { text: "hi" },
      max_price_usdc: "0.10",
      callback_url: "https://buyer.example/callback",
    });

    assert.equal(res.job_id, "job-42");
    const hireCall = calls.find((c) => c.url === `${SELLER_ENDPOINT}/hire`);
    assert.ok(hireCall, "hire must be POSTed to the listing's endpoint");
    assert.equal(
      (hireCall.body as { callback_url: string }).callback_url,
      "https://buyer.example/callback",
    );
  });

  test("throws HireRefusedError when the agent has no listing for the capability", async (t) => {
    const { restore } = mockFetch([
      {
        match: (url, method) =>
          url.includes(`/v1/agents/${SELLER}/listings`) && method === "GET",
        respond: () => jsonResponse({ listings: [SELLER_LISTING] }),
      },
    ]);
    t.after(restore);

    const client = makeClient();
    await assert.rejects(
      client.hireAsync({
        agent_id: SELLER,
        capability: "image.generate.photorealistic.png",
        params: {},
        max_price_usdc: "0.10",
        callback_url: "https://buyer.example/callback",
      }),
      (err: unknown) =>
        err instanceof HireRefusedError &&
        err.message.includes("has no listing for"),
    );
  });
});

describe("hire() budget accounting", () => {
  // The seller's hire response routes are shared by both tests; only the
  // capability (and thus the verification outcome) differs.
  function hireRoutes(capability: string, result: Record<string, unknown>) {
    return [
      {
        match: (url: string, method: string) =>
          url.includes("/v1/search") && method === "POST",
        respond: () =>
          jsonResponse({
            agents: [
              {
                ...SELLER_SEARCH_ENTRY,
                listing: { ...SELLER_LISTING, capability },
              },
            ],
            next_cursor: null,
            match: "exact",
          }),
      },
      {
        match: (url: string, method: string) =>
          url === `${SELLER_ENDPOINT}/hire` && method === "POST",
        respond: () =>
          jsonResponse({
            protocol: PROTOCOL_VERSION,
            receipt: { ...RECEIPT, capability },
            result,
            verification: { checks: [], all_passed: true },
            rating_token: "tok-1",
          }),
      },
    ];
  }

  test("records spend even when client-side verification fails", async (t) => {
    // audio.transcribe has a built-in verifier; an empty result fails it.
    const { restore } = mockFetch(
      hireRoutes("audio.transcribe.json-with-timestamps", {}),
    );
    t.after(restore);

    const client = makeClient({ budget: makeBudget("1.00") });
    await assert.rejects(
      client.hire({
        capability: "audio.transcribe.json-with-timestamps",
        params: {},
        max_price_usdc: "0.05",
      }),
      VerificationFailedError,
    );
    // The payment settled on-chain before verification ran, so the budget
    // must reflect it — this was the drift bug.
    assert.equal(client.remainingBudget(), "0.95");
  });

  test("records spend exactly once on a successful hire", async (t) => {
    // custom.* has no registered verifier → verification passes.
    const { restore } = mockFetch(hireRoutes("custom.test.echo", { ok: true }));
    t.after(restore);

    const client = makeClient({ budget: makeBudget("1.00") });
    const res = await client.hire({
      capability: "custom.test.echo",
      params: {},
      max_price_usdc: "0.05",
    });
    assert.equal(res.receipt.price_paid_usdc, "0.05");
    assert.equal(client.remainingBudget(), "0.95");
  });
});

describe("payX402 (raw external x402 call)", () => {
  const EXT_URL = "https://api.exa.example/search";

  test("POSTs the native body to the external URL and returns the raw response", async (t) => {
    const { calls, restore } = mockFetch([
      {
        match: (url, method) => url === EXT_URL && method === "POST",
        respond: () => jsonResponse({ results: [{ title: "hit" }] }),
      },
    ]);
    t.after(restore);

    const client = makeClient();
    const res = await client.payX402({
      url: EXT_URL,
      body: { query: "agents" },
      max_price_usdc: "0.05",
    });

    assert.equal(res.url, EXT_URL);
    assert.equal(res.status, 200);
    assert.deepEqual(res.data, { results: [{ title: "hit" }] });

    const call = calls.find((c) => c.url === EXT_URL);
    assert.ok(call, "payX402 must call the external URL");
    assert.equal(call.method, "POST");
    assert.deepEqual(call.body, { query: "agents" });
  });

  test("defaults to GET when no body is provided", async (t) => {
    const { calls, restore } = mockFetch([
      {
        match: (url, method) => url === EXT_URL && method === "GET",
        respond: () => jsonResponse({ ok: true }),
      },
    ]);
    t.after(restore);

    const client = makeClient();
    await client.payX402({ url: EXT_URL });
    assert.equal(calls.find((c) => c.url === EXT_URL)?.method, "GET");
  });

  test("books no spend when the endpoint answers 200 without a 402 challenge", async (t) => {
    const { restore } = mockFetch([
      {
        match: (url) => url === EXT_URL,
        respond: () => jsonResponse({ ok: true }),
      },
    ]);
    t.after(restore);

    const client = makeClient({ budget: makeBudget("1.00") });
    const res = await client.payX402({ url: EXT_URL, body: {} });
    assert.equal(res.amount_paid_usdc, undefined);
    assert.equal(client.remainingBudget(), "1.00");
  });

  test("submits a client-observed reliability record", async (t) => {
    const reliabilityUrl =
      "https://api.swarmwage.com/v1/reliability/external-x402";
    const { calls, restore } = mockFetch([
      {
        match: (url) => url === EXT_URL,
        respond: () => jsonResponse({ ok: true }),
      },
      {
        match: (url, method) => url === reliabilityUrl && method === "POST",
        respond: () =>
          jsonResponse({
            ok: true,
            reliability_record_id: "rel_123",
            trust_level: "client_observed",
          }),
      },
    ]);
    t.after(restore);

    const client = makeClient();
    const res = await client.payX402({
      url: EXT_URL,
      method: "POST",
      body: { query: "agents" },
      source: "agentic.market",
      service_id: "svc-search",
      service_name: "Search Service",
      endpoint_description: "Search the web",
      category: "Search",
      pricing_scheme: "exact",
    });

    assert.equal(res.reliability_record_id, "rel_123");
    assert.match(res.request_hash ?? "", /^0x[a-f0-9]{64}$/);
    assert.match(res.response_hash ?? "", /^0x[a-f0-9]{64}$/);

    const reliabilityCall = calls.find((c) => c.url === reliabilityUrl);
    assert.ok(reliabilityCall);
    const reliabilityBody = reliabilityCall.body as Record<string, unknown>;
    assert.equal(reliabilityCall.method, "POST");
    assert.equal(reliabilityBody.trust_level, "client_observed");
    assert.equal(reliabilityBody.buyer_agent_id, client.agentId);
    assert.equal(reliabilityBody.source, "agentic.market");
    assert.equal(reliabilityBody.service_id, "svc-search");
    assert.equal(reliabilityBody.status, 200);
    assert.equal(reliabilityBody.verifier_status, "unknown");
    assert.equal(reliabilityBody.response_hash, res.response_hash);
  });

  test("includes external catalog metadata in x402 telemetry", async (t) => {
    const telemetryUrl = "https://api.swarmwage.com/telemetry";
    const { calls, restore } = mockFetch([
      {
        match: (url) => url === EXT_URL,
        respond: () => jsonResponse({ ok: true }),
      },
      {
        match: (url, method) => url === telemetryUrl && method === "POST",
        respond: () => new Response(null, { status: 204 }),
      },
    ]);
    t.after(restore);

    const client = new AgentClient({
      privateKey: TEST_PRIVATE_KEY,
      telemetry: true,
    });
    await client.payX402({
      url: EXT_URL,
      method: "POST",
      body: { query: "agents" },
      max_price_usdc: "0.02",
      source: "agentic.market",
      service_id: "exa-ai",
      service_name: "Exa",
      endpoint_description: "Search the web",
      category: "Search",
      pricing_scheme: "exact",
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    const telemetryEvents = calls
      .filter((c) => c.url === telemetryUrl)
      .map((c) => c.body as { event: Record<string, unknown> });
    assert.equal(telemetryEvents.length, 2);
    assert.deepEqual(
      telemetryEvents.map((e) => e.event.kind),
      ["x402_call", "x402_call_complete"],
    );
    for (const { event } of telemetryEvents) {
      assert.equal(event.url, EXT_URL);
      assert.equal(event.method, "POST");
      assert.equal(event.max_price_usdc, "0.02");
      assert.equal(event.source, "agentic.market");
      assert.equal(event.service_id, "exa-ai");
      assert.equal(event.service_name, "Exa");
      assert.equal(event.endpoint_description, "Search the web");
      assert.equal(event.category, "Search");
      assert.equal(event.pricing_scheme, "exact");
    }
  });
});
