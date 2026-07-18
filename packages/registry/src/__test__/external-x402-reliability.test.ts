// Swarmwage Registry — external x402 reliability tests
// License: BUSL-1.1

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createApp } from "../app.js";

const BUYER = "0x00000000000000000000000000000000000000b1";
const RESPONSE_HASH = `0x${"a".repeat(64)}`;
const REQUEST_HASH = `0x${"b".repeat(64)}`;
const TX_HASH = `0x${"c".repeat(64)}`;

function record(overrides: Record<string, unknown> = {}) {
  return {
    buyer_agent_id: BUYER,
    source: "agentic.market",
    service_id: "svc-search",
    service_name: "Search Service",
    category: "Search",
    endpoint_description: "Search the web",
    pricing_scheme: "exact",
    url: "https://api.example.com/search",
    method: "POST",
    status: 200,
    amount_paid_usdc: "0.02",
    tx_hash: TX_HASH,
    latency_ms: 120,
    request_hash: REQUEST_HASH,
    response_hash: RESPONSE_HASH,
    verifier_kind: "none",
    verifier_status: "unknown",
    verifier_checks: {},
    ...overrides,
  };
}

describe("external x402 reliability", () => {
  it("accepts client-observed records and returns service aggregates", async () => {
    const { app } = createApp({ enableRequestLogger: false });

    const first = await app.request("/v1/reliability/external-x402", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(record({ latency_ms: 100 })),
    });
    assert.equal(first.status, 200);
    const firstJson = (await first.json()) as { reliability_record_id: string };
    assert.match(firstJson.reliability_record_id, /^[0-9a-f-]{36}$/);

    const second = await app.request("/v1/reliability/external-x402", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        record({
          status: 500,
          amount_paid_usdc: undefined,
          tx_hash: undefined,
          latency_ms: 200,
          error: "HTTP 500",
        }),
      ),
    });
    assert.equal(second.status, 200);

    const res = await app.request(
      "/v1/reliability/external-x402?source=agentic.market&service_id=svc-search&url=https%3A%2F%2Fapi.example.com%2Fsearch",
    );
    assert.equal(res.status, 200);
    const json = (await res.json()) as {
      trust_level: string;
      count: number;
      note: string;
      services: Array<{
        calls: number;
        paid_calls: number;
        success_rate: number;
        final_status_counts: Record<string, number>;
        latency_ms: { p50: number; p95: number };
        verifier_counts: Record<string, number>;
        tx_hash_coverage: number;
      }>;
    };
    assert.equal(json.trust_level, "client_observed");
    assert.match(json.note, /client-observed reliability evidence/);
    assert.equal(json.count, 1);
    assert.equal(json.services[0]!.calls, 2);
    assert.equal(json.services[0]!.paid_calls, 1);
    assert.equal(json.services[0]!.success_rate, 0.5);
    assert.deepEqual(json.services[0]!.final_status_counts, {
      "200": 1,
      "500": 1,
    });
    assert.equal(json.services[0]!.latency_ms.p50, 100);
    assert.equal(json.services[0]!.latency_ms.p95, 200);
    assert.equal(json.services[0]!.verifier_counts.unknown, 2);
    assert.equal(json.services[0]!.tx_hash_coverage, 0.5);
  });

  it("rejects malformed hashes", async () => {
    const { app } = createApp({ enableRequestLogger: false });
    const res = await app.request("/v1/reliability/external-x402", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(record({ response_hash: "0x1234" })),
    });
    assert.equal(res.status, 400);
  });

  it("filters by exact URL", async () => {
    const { app } = createApp({ enableRequestLogger: false });
    await app.request("/v1/reliability/external-x402", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(record({ url: "https://api.example.com/a" })),
    });
    await app.request("/v1/reliability/external-x402", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(record({ url: "https://api.example.com/b" })),
    });

    const res = await app.request(
      "/v1/reliability/external-x402?url=https%3A%2F%2Fapi.example.com%2Fb",
    );
    assert.equal(res.status, 200);
    const json = (await res.json()) as {
      count: number;
      services: Array<{ url: string }>;
    };
    assert.equal(json.count, 1);
    assert.equal(json.services[0]!.url, "https://api.example.com/b");
  });
});
