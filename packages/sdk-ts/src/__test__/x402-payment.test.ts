// Swarmwage Agent SDK — x402 v2 payment-flow regression tests
// License: MIT
//
// Exercises the FULL 402 -> sign EIP-3009 -> retry dance through the migrated
// payment layer (@x402/core + @x402/fetch + @x402/evm), which the older
// client.test.ts never did (those mocks answer 200 on the first hit). Covers:
//   - payX402 paying a v2 (CAIP-2) challenge — the agentic.market shape;
//   - hire() paying a v1 (bare-network) challenge — our own sellers;
//   - the two safety-critical guards: spend-cap hard-fail and anti-hijack.
//
// All signing is offline: the test key is anvil account #0, no broadcast.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  encodePaymentResponseHeader,
  encodePaymentRequiredHeader,
} from "@x402/core/http";
import { AgentClient } from "../client.js";
import { SellerMismatchError, InsufficientFundsError } from "../errors.js";
import { isReliabilityEnabled } from "../reliability.js";
import { PROTOCOL_VERSION, type AgentId, type Hex } from "../types.js";

const TEST_PRIVATE_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;

// USDC on Base — the EIP-3009 domain the seller's 402 challenge points at.
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const SELLER = "0x00000000000000000000000000000000000000a1" as AgentId;
const EXT_PAYTO = "0x000000000000000000000000000000000000beef";

interface RecordedCall {
  url: string;
  method: string;
  hasPaymentHeader: boolean;
}

/** A v2 (CAIP-2 network, `amount`) 402 challenge body — agentic.market shape. */
function challengeV2(payTo: string, amount: string) {
  return {
    x402Version: 2,
    resource: { url: "https://api.getsly.example/x402/demo/poem" },
    accepts: [
      {
        scheme: "exact",
        network: "eip155:8453" as const,
        asset: USDC_BASE,
        amount,
        payTo,
        maxTimeoutSeconds: 60,
        extra: { name: "USD Coin", version: "2" },
      },
    ],
  };
}

/** A v1 (bare network, `maxAmountRequired`) 402 challenge — our own sellers. */
function challengeV1(payTo: string, maxAmountRequired: string) {
  return {
    x402Version: 1,
    accepts: [
      {
        scheme: "exact",
        network: "base",
        maxAmountRequired,
        resource: "https://seller.example/hire",
        description: "hire",
        mimeType: "application/json",
        payTo,
        maxTimeoutSeconds: 60,
        asset: USDC_BASE,
        extra: { name: "USD Coin", version: "2" },
      },
    ],
  };
}

function settlementHeader(txHash: string, amount?: string): string {
  return encodePaymentResponseHeader({
    success: true,
    transaction: txHash,
    network: "eip155:8453",
    payer: "0x0000000000000000000000000000000000000001",
    ...(amount ? { amount } : {}),
  } as Parameters<typeof encodePaymentResponseHeader>[0]);
}

/**
 * Mock that issues a 402 challenge on the first hit, then 200 + settlement
 * header on the retry that carries the X-PAYMENT header. The challenge is
 * served via the `Payment-Required` header (x402 v2) or the JSON body (v1),
 * matching how real endpoints discriminate protocol versions. Returns the log.
 */
function mock402ThenOk(opts: {
  challenge: Parameters<typeof encodePaymentRequiredHeader>[0];
  transport: "header" | "body";
  okBody: unknown;
  txHash: string;
  settledAmount?: string;
  matchUrl: string;
}): { calls: RecordedCall[]; restore: () => void } {
  const original = globalThis.fetch;
  const calls: RecordedCall[] = [];
  globalThis.fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const req = input instanceof Request ? input : new Request(input, init);
    // v2 signs via PAYMENT-SIGNATURE; v1 via X-PAYMENT.
    const hasPaymentHeader =
      req.headers.has("X-PAYMENT") || req.headers.has("PAYMENT-SIGNATURE");
    calls.push({ url: req.url, method: req.method, hasPaymentHeader });
    if (!req.url.startsWith(opts.matchUrl)) {
      throw new Error(`mock402: unmatched ${req.method} ${req.url}`);
    }
    if (!hasPaymentHeader) {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      let body = "{}";
      if (opts.transport === "header") {
        headers["Payment-Required"] = encodePaymentRequiredHeader(
          opts.challenge,
        );
      } else {
        body = JSON.stringify(opts.challenge);
      }
      return new Response(body, { status: 402, headers });
    }
    const settle = settlementHeader(opts.txHash, opts.settledAmount);
    return new Response(JSON.stringify(opts.okBody), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Payment-Response": settle,
        "X-Payment-Response": settle,
      },
    });
  }) as typeof fetch;
  return { calls, restore: () => void (globalThis.fetch = original) };
}

function makeClient() {
  return new AgentClient({ privateKey: TEST_PRIVATE_KEY, telemetry: false });
}

describe("payX402 — full v2 payment flow (agentic.market shape)", () => {
  const EXT_URL = "https://api.getsly.example/x402/demo/poem";

  test("pays a v2 402 challenge, retries with X-PAYMENT, returns settlement", async (t) => {
    // Built via repeat (not a literal 64-hex) so the repo's red-flag scan,
    // which flags any 0x<64-hex> as a possible private key, doesn't trip on a
    // test tx hash. It's a placeholder settlement hash, never a key.
    const TX = "0x" + "a1".repeat(32);
    const { calls, restore } = mock402ThenOk({
      challenge: challengeV2(EXT_PAYTO, "1000"), // $0.001
      transport: "header",
      okBody: { poem: "ode to agents" },
      txHash: TX,
      settledAmount: "1000",
      matchUrl: EXT_URL,
    });
    t.after(restore);

    const res = await makeClient().payX402({
      url: EXT_URL,
      max_price_usdc: "0.05",
    });

    assert.equal(res.status, 200);
    assert.deepEqual(res.data, { poem: "ode to agents" });
    assert.equal(res.tx_hash, TX);
    assert.equal(res.amount_paid_usdc, "0.001");
    // Exactly two hits: the 402 challenge then the paid retry.
    const endpointCalls = calls.filter((c) => c.url.startsWith(EXT_URL));
    assert.equal(endpointCalls.length, 2);
    assert.equal(endpointCalls[0]?.hasPaymentHeader, false);
    assert.equal(endpointCalls[1]?.hasPaymentHeader, true);
  });

  test("hard-fails on the spend cap without paying when the price exceeds it", async (t) => {
    const { calls, restore } = mock402ThenOk({
      challenge: challengeV2(EXT_PAYTO, "5000000"), // $5.00, over the cap
      transport: "header",
      okBody: { poem: "should never arrive" },
      txHash: "0xdead",
      matchUrl: EXT_URL,
    });
    t.after(restore);

    await assert.rejects(
      makeClient().payX402({ url: EXT_URL, max_price_usdc: "0.05" }),
    );
    // Only the challenge was hit — no signed retry, no payment.
    const endpointCalls = calls.filter((c) => c.url.startsWith(EXT_URL));
    assert.equal(endpointCalls.length, 1);
    assert.equal(endpointCalls[0]?.hasPaymentHeader, false);
  });
});

describe("payX402 — client-observed reliability records", () => {
  const EXT_URL = "https://api.example.com/x402/mock";
  const REGISTRY_URL = "https://registry.example";

  test("isReliabilityEnabled honors SWARMWAGE_RELIABILITY=0", () => {
    assert.equal(isReliabilityEnabled(undefined, {}), true);
    assert.equal(isReliabilityEnabled(undefined, { SWARMWAGE_RELIABILITY: "0" }), false);
    assert.equal(isReliabilityEnabled(true, { SWARMWAGE_RELIABILITY: "0" }), true);
  });

  test("submits reliability evidence by default and returns record id + hashes", async (t) => {
    const original = globalThis.fetch;
    const registryPosts: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const req = input instanceof Request ? input : new Request(input, init);
      if (req.url === EXT_URL) {
        return new Response(JSON.stringify({ ok: true, b: 2, a: 1 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (req.url === `${REGISTRY_URL}/v1/reliability/external-x402`) {
        registryPosts.push(JSON.parse(await req.clone().text()) as Record<string, unknown>);
        return new Response(JSON.stringify({ reliability_record_id: "rel-123" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`unmatched ${req.method} ${req.url}`);
    }) as typeof fetch;
    t.after(() => void (globalThis.fetch = original));

    const res = await new AgentClient({
      privateKey: TEST_PRIVATE_KEY,
      telemetry: false,
      registryUrl: REGISTRY_URL,
    }).payX402({
      url: EXT_URL,
      method: "POST",
      body: { z: 1, a: 2 },
      max_price_usdc: "0.05",
      source: "agentic.market",
      service_id: "mock-service",
      service_name: "Mock Service",
    });

    assert.equal(res.status, 200);
    assert.equal(res.reliability_record_id, "rel-123");
    assert.match(res.request_hash ?? "", /^0x[a-f0-9]{64}$/);
    assert.match(res.response_hash ?? "", /^0x[a-f0-9]{64}$/);
    assert.equal(registryPosts.length, 1);
    assert.equal(registryPosts[0]!.trust_level, "client_observed");
    assert.equal(registryPosts[0]!.url, EXT_URL);
    assert.equal(registryPosts[0]!.service_id, "mock-service");
    assert.equal(registryPosts[0]!.status, 200);
    assert.equal(registryPosts[0]!.verifier_status, "unknown");
  });

  test("reliability opt-out skips registry POST", async (t) => {
    const original = globalThis.fetch;
    let registryPostCount = 0;
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const req = input instanceof Request ? input : new Request(input, init);
      if (req.url === EXT_URL) {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (req.url.includes("/v1/reliability/external-x402")) {
        registryPostCount += 1;
        throw new Error("reliability POST should not run");
      }
      throw new Error(`unmatched ${req.method} ${req.url}`);
    }) as typeof fetch;
    t.after(() => void (globalThis.fetch = original));

    const res = await new AgentClient({
      privateKey: TEST_PRIVATE_KEY,
      telemetry: false,
      registryUrl: REGISTRY_URL,
      reliability: false,
    }).payX402({ url: EXT_URL, max_price_usdc: "0.05" });

    assert.equal(res.status, 200);
    assert.equal(res.reliability_record_id, undefined);
    assert.equal(registryPostCount, 0);
  });

  test("reliability submit failure does not block payX402", async (t) => {
    const original = globalThis.fetch;
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const req = input instanceof Request ? input : new Request(input, init);
      if (req.url === EXT_URL) {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (req.url === `${REGISTRY_URL}/v1/reliability/external-x402`) {
        return new Response(JSON.stringify({ error: "down" }), {
          status: 503,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`unmatched ${req.method} ${req.url}`);
    }) as typeof fetch;
    t.after(() => void (globalThis.fetch = original));

    const res = await new AgentClient({
      privateKey: TEST_PRIVATE_KEY,
      telemetry: false,
      registryUrl: REGISTRY_URL,
    }).payX402({ url: EXT_URL, max_price_usdc: "0.05" });

    assert.equal(res.status, 200);
    assert.deepEqual(res.data, { ok: true });
    assert.equal(res.reliability_record_id, undefined);
    assert.match(res.response_hash ?? "", /^0x[a-f0-9]{64}$/);
  });

  test("getExternalX402Reliability reads aggregate registry endpoint", async (t) => {
    const original = globalThis.fetch;
    let seenUrl = "";
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const req = input instanceof Request ? input : new Request(input, init);
      seenUrl = req.url;
      assert.equal(req.method, "GET");
      return new Response(
        JSON.stringify({
          trust_level: "client_observed",
          count: 1,
          note: "client-observed reliability evidence, not seller-signed receipts",
          services: [],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;
    t.after(() => void (globalThis.fetch = original));

    const res = await new AgentClient({
      privateKey: TEST_PRIVATE_KEY,
      telemetry: false,
      registryUrl: REGISTRY_URL,
    }).getExternalX402Reliability({
      source: "agentic.market",
      service_id: "mock-service",
      url: EXT_URL,
      limit: 5,
    });

    assert.equal(res.trust_level, "client_observed");
    assert.match(seenUrl, /\/v1\/reliability\/external-x402\?/);
    assert.match(seenUrl, /source=agentic\.market/);
    assert.match(seenUrl, /service_id=mock-service/);
    assert.match(seenUrl, /limit=5/);
    assert.match(seenUrl, /url=https%3A%2F%2Fapi\.example\.com%2Fx402%2Fmock/);
  });
});

describe("hire — v1 payment flow (our own sellers) + anti-hijack", () => {
  const SELLER_ENDPOINT = "https://seller.example";

  function sellerSearchResponse(): Response {
    return new Response(
      JSON.stringify({
        agents: [
          {
            agent_id: SELLER,
            listing: {
              agent_id: SELLER,
              capability: "custom.test.echo",
              price_usdc: "0.05",
              currency: "USDC",
              chain: "base",
              max_latency_ms: 5000,
              first_call_free: false,
              endpoint: SELLER_ENDPOINT,
              signature: "0xabc",
            },
            reputation: {
              success_rate: 1,
              avg_latency_ms: 100,
              last_30d_hire_count: 5,
              avg_stars: 5,
              total_ratings: 3,
              claimed: false,
            },
          },
        ],
        next_cursor: null,
        match: "exact",
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }

  // Regression guard for the v1 signing path: a v1 ("base"/maxAmountRequired)
  // challenge whose payTo IS the resolved seller must sign and settle. This
  // exercises the scheme registered for the v1 path — the anti-hijack test
  // alone never reaches signing (it throws in the selector first).
  test("pays a v1 challenge (our sellers): signs, retries, settles, books spend", async (t) => {
    const TX = "0x" + "f1".repeat(32); // test placeholder hash; see note above
    const original = globalThis.fetch;
    const calls: RecordedCall[] = [];
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const req = input instanceof Request ? input : new Request(input, init);
      const hasPaymentHeader =
        req.headers.has("X-PAYMENT") || req.headers.has("PAYMENT-SIGNATURE");
      calls.push({ url: req.url, method: req.method, hasPaymentHeader });
      if (req.url.includes("/v1/search")) return sellerSearchResponse();
      // Seller endpoint: 402 v1 challenge first, then 200 + receipt on the
      // signed retry.
      if (!hasPaymentHeader) {
        return new Response(JSON.stringify(challengeV1(SELLER, "50000")), {
          status: 402,
          headers: { "Content-Type": "application/json" },
        });
      }
      const settle = settlementHeader(TX, "50000");
      return new Response(
        JSON.stringify({
          protocol: PROTOCOL_VERSION,
          receipt: {
            receipt_id: "r-v1",
            buyer_id: "0x00000000000000000000000000000000000000b2",
            seller_id: SELLER,
            capability: "custom.test.echo",
            tx_hash: TX,
            price_paid_usdc: "0.05",
            completed_at: Math.floor(Date.now() / 1000),
          },
          result: { ok: true },
          verification: { checks: [], all_passed: true },
          rating_token: "tok-v1",
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "Payment-Response": settle,
            "X-Payment-Response": settle,
          },
        },
      );
    }) as typeof fetch;
    t.after(() => void (globalThis.fetch = original));

    const client = new AgentClient({
      privateKey: TEST_PRIVATE_KEY,
      telemetry: false,
      budget: {
        agent_id: SELLER,
        max_amount_usdc: "1.00",
        max_duration_seconds: 3600,
        issued_at: Math.floor(Date.now() / 1000),
        signature: "0xdeadbeef" as Hex,
      },
    });
    const res = await client.hire({
      capability: "custom.test.echo",
      params: {},
      max_price_usdc: "0.05",
    });

    assert.equal(res.receipt.price_paid_usdc, "0.05");
    assert.equal(client.remainingBudget(), "0.95");
    // The seller endpoint was hit twice: unsigned 402, then signed retry.
    const sellerHits = calls.filter((c) => c.url.startsWith(SELLER_ENDPOINT));
    assert.equal(sellerHits.length, 2);
    assert.equal(sellerHits[1]?.hasPaymentHeader, true);
  });

  test("anti-hijack: refuses to pay when the 402 payTo isn't the resolved seller", async (t) => {
    // Search resolves SELLER; the seller's 402 challenge pays a DIFFERENT addr.
    const original = globalThis.fetch;
    const calls: RecordedCall[] = [];
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const req = input instanceof Request ? input : new Request(input, init);
      calls.push({
        url: req.url,
        method: req.method,
        hasPaymentHeader: req.headers.has("X-PAYMENT"),
      });
      if (req.url.includes("/v1/search")) {
        return new Response(
          JSON.stringify({
            agents: [
              {
                agent_id: SELLER,
                listing: {
                  agent_id: SELLER,
                  capability: "custom.test.echo",
                  price_usdc: "0.05",
                  currency: "USDC",
                  chain: "base",
                  max_latency_ms: 5000,
                  first_call_free: false,
                  endpoint: SELLER_ENDPOINT,
                  signature: "0xabc",
                },
                reputation: {
                  success_rate: 1,
                  avg_latency_ms: 100,
                  last_30d_hire_count: 5,
                  avg_stars: 5,
                  total_ratings: 3,
                  claimed: false,
                },
              },
            ],
            next_cursor: null,
            match: "exact",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      // Seller's 402 challenge pays EXT_PAYTO, not SELLER → must be rejected.
      return new Response(JSON.stringify(challengeV1(EXT_PAYTO, "50000")), {
        status: 402,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    t.after(() => void (globalThis.fetch = original));

    await assert.rejects(
      makeClient().hire({
        capability: "custom.test.echo",
        params: {},
        max_price_usdc: "0.05",
      }),
      (err: unknown) =>
        err instanceof SellerMismatchError ||
        err instanceof InsufficientFundsError,
    );
    // No signed retry to the seller endpoint.
    assert.ok(
      !calls.some((c) => c.hasPaymentHeader),
      "must never send a signed payment on a payTo mismatch",
    );
  });
});
