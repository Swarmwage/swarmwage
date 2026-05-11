// Swarmwage Registry — GET /v1/agents/:id/listings + /v1/agents/:id/receipts
// Read-only seller-side endpoints. Power the `list_my_listings` and
// `get_my_receipts` MCP tools.
// License: BUSL-1.1

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { keccak256, toBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { createApp } from "../app.js";

const SELLER_KEY =
  "0x5555555555555555555555555555555555555555555555555555555555555555" as const;
const SELLER_ACCOUNT = privateKeyToAccount(SELLER_KEY);
const SELLER_ID = SELLER_ACCOUNT.address.toLowerCase();

const BUYER_ID = "0x2222222222222222222222222222222222222222";

async function signCanonical(
  account: ReturnType<typeof privateKeyToAccount>,
  payload: object,
): Promise<`0x${string}`> {
  const canonical = JSON.stringify(payload, Object.keys(payload).sort());
  const hash = keccak256(toBytes(canonical));
  return account.signMessage({ message: { raw: hash } });
}

async function postListing(
  app: ReturnType<typeof createApp>["app"],
  capability: string,
  price_usdc: string,
) {
  const payload = {
    agent_id: SELLER_ID,
    capability,
    price_usdc,
    currency: "USDC",
    chain: "base",
    max_latency_ms: 5000,
    first_call_free: false,
    endpoint: `https://seller.example/${capability}`,
  };
  const signature = await signCanonical(SELLER_ACCOUNT, payload);
  return app.request("/v1/listings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...payload, signature }),
  });
}

async function postReceipt(
  app: ReturnType<typeof createApp>["app"],
  capability: string,
  txSuffix: string,
) {
  const input = {
    protocol_version: "swarmwage/v0.1",
    hire_id: `hire-${capability}-${txSuffix}`,
    agent_id: SELLER_ID,
    buyer: BUYER_ID,
    capability,
    amount_usdc_atomic: "20000",
    network: "base-sepolia",
    tx_hash: `0x${"a".repeat(63)}${txSuffix}`,
    completed_at: new Date().toISOString(),
    verification: { all_passed: true, checks: { schema_ok: true } },
  };
  const signature = await signCanonical(SELLER_ACCOUNT, input);
  return app.request("/v1/receipts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...input, signature }),
  });
}

describe("GET /v1/agents/:id/listings", () => {
  let appHandle: ReturnType<typeof createApp>;

  before(async () => {
    appHandle = createApp({ enableRequestLogger: false });
    const r1 = await postListing(appHandle.app, "image.generate.png", "0.05");
    const r2 = await postListing(appHandle.app, "chart.generate.png", "0.02");
    assert.equal(r1.status, 200);
    assert.equal(r2.status, 200);
  });

  it("returns all listings for a known seller", async () => {
    const res = await appHandle.app.request(
      `/v1/agents/${SELLER_ID}/listings`,
    );
    assert.equal(res.status, 200);
    const json = (await res.json()) as {
      agent_id: string;
      count: number;
      listings: Array<{ capability: string }>;
    };
    assert.equal(json.agent_id, SELLER_ID);
    assert.equal(json.count, 2);
    const caps = json.listings.map((l) => l.capability).sort();
    assert.deepEqual(caps, ["chart.generate.png", "image.generate.png"]);
  });

  it("returns count=0 listings for an unknown agent", async () => {
    const res = await appHandle.app.request(
      "/v1/agents/0x0000000000000000000000000000000000000099/listings",
    );
    assert.equal(res.status, 200);
    const json = (await res.json()) as { count: number };
    assert.equal(json.count, 0);
  });

  it("rejects an invalid agent_id with 400", async () => {
    const res = await appHandle.app.request("/v1/agents/not-an-address/listings");
    assert.equal(res.status, 400);
  });
});

describe("GET /v1/agents/:id/receipts", () => {
  let appHandle: ReturnType<typeof createApp>;

  before(async () => {
    appHandle = createApp({ enableRequestLogger: false });
    // Submit 3 receipts spaced by capability suffix to differentiate.
    const a = await postReceipt(appHandle.app, "image.generate.png", "1");
    const b = await postReceipt(appHandle.app, "chart.generate.png", "2");
    const c = await postReceipt(appHandle.app, "audio.transcribe.json", "3");
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal(c.status, 200);
  });

  it("returns recent receipts for a seller, most recent first", async () => {
    const res = await appHandle.app.request(
      `/v1/agents/${SELLER_ID}/receipts`,
    );
    assert.equal(res.status, 200);
    const json = (await res.json()) as {
      agent_id: string;
      count: number;
      receipts: Array<{ capability: string; ts?: number }>;
    };
    assert.equal(json.agent_id, SELLER_ID);
    assert.equal(json.count, 3);
    // Ordering: ts DESC. Memory store stamps `ts = Date.now()` at append,
    // so the last receipt submitted should sort first.
    assert.equal(json.receipts[0]?.capability, "audio.transcribe.json");
  });

  it("respects the limit query param", async () => {
    const res = await appHandle.app.request(
      `/v1/agents/${SELLER_ID}/receipts?limit=2`,
    );
    assert.equal(res.status, 200);
    const json = (await res.json()) as { count: number };
    assert.equal(json.count, 2);
  });

  it("rejects invalid limit with 400", async () => {
    const res = await appHandle.app.request(
      `/v1/agents/${SELLER_ID}/receipts?limit=-1`,
    );
    assert.equal(res.status, 400);
  });

  it("returns count=0 for an unknown agent", async () => {
    const res = await appHandle.app.request(
      "/v1/agents/0x0000000000000000000000000000000000000099/receipts",
    );
    assert.equal(res.status, 200);
    const json = (await res.json()) as { count: number };
    assert.equal(json.count, 0);
  });
});
