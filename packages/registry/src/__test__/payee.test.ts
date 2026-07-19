// Swarmwage Registry — separate payee (GH #11) acceptance tests
// License: BUSL-1.1
//
// Covers the issue's acceptance checks observable at the registry:
//  1. absent payee → deterministic fallback to agent_id (legacy unchanged)
//  2. present payee → returned in search, drives recipient→agent_id lookup
//  3. tampered payee → listing signature invalid
//  4. receipts bind agent_id + payee; payee ≠ listing payee is rejected
//  5. buyer == payee wash-trading rejected

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { keccak256, toBytes } from "viem";
import { canonicalize } from "@swarmwage/agent-sdk";
import { privateKeyToAccount } from "viem/accounts";

import { createApp } from "../app.js";

// Deterministic toy key (repeated byte) — never funded, test-only.
const SELLER_KEY = `0x${"55".repeat(32)}` as `0x${string}`;
const SELLER_ACCOUNT = privateKeyToAccount(SELLER_KEY);
const SELLER_ID = SELLER_ACCOUNT.address.toLowerCase();

// Address only — its key never appears in this file, mirroring production.
const PAYEE = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER_PAYEE = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const BUYER_ID = "0x1234567890123456789012345678901234567890";

const CAPABILITY = "custom.payee.echo";

async function signCanonical(payload: object): Promise<`0x${string}`> {
  const hash = keccak256(toBytes(canonicalize(payload)));
  return SELLER_ACCOUNT.signMessage({ message: { raw: hash } });
}

function listingPayload(payee?: string) {
  return {
    agent_id: SELLER_ID,
    ...(payee ? { payee } : {}),
    capability: CAPABILITY,
    price_usdc: "0.05",
    currency: "USDC",
    chain: "base",
    max_latency_ms: 5000,
    first_call_free: false,
    endpoint: `https://seller.example/${CAPABILITY}`,
  };
}

async function publish(
  app: ReturnType<typeof createApp>["app"],
  body: Record<string, unknown>,
) {
  const res = await app.request("/v1/listings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, json };
}

async function submitReceipt(
  app: ReturnType<typeof createApp>["app"],
  overrides: Record<string, unknown> = {},
) {
  const payload = {
    protocol_version: "swarmwage/v0.1",
    hire_id: `hire-${Math.random().toString(36).slice(2)}`,
    agent_id: SELLER_ID,
    payee: PAYEE,
    buyer: BUYER_ID,
    capability: CAPABILITY,
    amount_usdc_atomic: "50000",
    network: "base" as const,
    tx_hash: `0x${"cd".repeat(32)}`,
    completed_at: new Date().toISOString(),
    verification: { all_passed: true, checks: { schema_ok: true } },
    ...overrides,
  };
  // Drop keys explicitly set to undefined so canonicalization matches what
  // a legacy seller (no payee key at all) actually signs.
  for (const k of Object.keys(payload)) {
    if ((payload as Record<string, unknown>)[k] === undefined) {
      delete (payload as Record<string, unknown>)[k];
    }
  }
  const signature = await signCanonical(payload);
  const res = await app.request("/v1/receipts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...payload, signature }),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, json };
}

describe("separate payee (GH #11)", () => {
  let appHandle: ReturnType<typeof createApp>;

  before(() => {
    appHandle = createApp({ enableRequestLogger: false });
  });

  it("publishes a payee listing and returns the payee in search results", async () => {
    const payload = listingPayload(PAYEE);
    const signature = await signCanonical(payload);
    const pub = await publish(appHandle.app, { ...payload, signature });
    assert.equal(pub.status, 200);

    const res = await appHandle.app.request("/v1/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ capability: CAPABILITY }),
    });
    const json = (await res.json()) as {
      agents: Array<{ agent_id: string; listing: { payee?: string } }>;
    };
    const entry = json.agents.find((a) => a.agent_id === SELLER_ID);
    assert.ok(entry, "payee listing must be searchable");
    assert.equal(entry.listing.payee, PAYEE);
  });

  it("rejects a listing whose payee was tampered after signing", async () => {
    const payload = listingPayload(PAYEE);
    const signature = await signCanonical(payload);
    const tampered = { ...payload, payee: OTHER_PAYEE, signature };
    const pub = await publish(appHandle.app, tampered);
    assert.equal(pub.status, 401);
    assert.match(String(pub.json.error), /signature/i);
  });

  it("resolves the payee address to the publishing agent (recipient lookup)", async () => {
    const res = await appHandle.app.request(
      `/v1/listings?recipient=${PAYEE}`,
      { method: "GET" },
    );
    assert.equal(res.status, 200);
    const json = (await res.json()) as { agent_id: string; recipient: string };
    assert.equal(json.agent_id, SELLER_ID);
    assert.equal(json.recipient, PAYEE);
  });

  it("still resolves a plain agent_id recipient (legacy fallback)", async () => {
    const res = await appHandle.app.request(
      `/v1/listings?recipient=${SELLER_ID}`,
      { method: "GET" },
    );
    assert.equal(res.status, 200);
    const json = (await res.json()) as { agent_id: string };
    assert.equal(json.agent_id, SELLER_ID);
  });

  it("accepts a receipt binding agent_id + the listing's signed payee", async () => {
    const r = await submitReceipt(appHandle.app);
    assert.equal(r.status, 200);
    assert.ok(r.json.receipt_id);

    const list = await appHandle.app.request(
      `/v1/agents/${SELLER_ID}/receipts`,
      { method: "GET" },
    );
    const json = (await list.json()) as {
      receipts: Array<{ payee?: string }>;
    };
    assert.ok(
      json.receipts.some((rec) => rec.payee === PAYEE),
      "stored receipt must bind the payee",
    );
  });

  it("rejects a receipt whose payee differs from the listing's signed payee", async () => {
    const r = await submitReceipt(appHandle.app, { payee: OTHER_PAYEE });
    assert.equal(r.status, 400);
    assert.match(String(r.json.error), /payee/i);
  });

  it("rejects a receipt omitting payee when the listing declares one", async () => {
    const r = await submitReceipt(appHandle.app, { payee: undefined });
    assert.equal(r.status, 400);
    assert.match(String(r.json.error), /payee/i);
  });

  it("rejects wash-trading where buyer == payee", async () => {
    const r = await submitReceipt(appHandle.app, { buyer: PAYEE });
    assert.equal(r.status, 400);
    assert.match(String(r.json.error), /Self-hire/i);
  });

  it("rejects a payee receipt with no backing listing (listing-first)", async () => {
    // Different capability ⇒ no live listing binds this payee for it.
    const r = await submitReceipt(appHandle.app, {
      capability: "custom.unlisted.cap",
    });
    assert.equal(r.status, 400);
    assert.match(String(r.json.error), /listing/i);
  });

  it("refuses payee attribution when two distinct agents claim the same payee", async () => {
    // Second agent claims the same PAYEE — the recipient lookup must refuse
    // to attribute rather than pick a winner.
    const otherKey = `0x${"66".repeat(32)}` as `0x${string}`;
    const otherAccount = privateKeyToAccount(otherKey);
    const payload = {
      agent_id: otherAccount.address.toLowerCase(),
      payee: PAYEE,
      capability: "custom.payee.squat",
      price_usdc: "0.01",
      currency: "USDC",
      chain: "base",
      max_latency_ms: 5000,
      first_call_free: false,
      endpoint: "https://squatter.example/cap",
    };
    const hash = keccak256(toBytes(canonicalize(payload)));
    const signature = await otherAccount.signMessage({
      message: { raw: hash },
    });
    const pub = await publish(appHandle.app, { ...payload, signature });
    assert.equal(pub.status, 200);

    const res = await appHandle.app.request(
      `/v1/listings?recipient=${PAYEE}`,
      { method: "GET" },
    );
    assert.equal(res.status, 404, "ambiguous payee must not attribute");
  });
});
