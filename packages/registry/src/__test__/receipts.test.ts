// Swarmwage Registry — POST /v1/receipts tests
// License: BUSL-1.1

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { keccak256, toBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { createApp } from "../app.js";

const SELLER_KEY =
  "0x3333333333333333333333333333333333333333333333333333333333333333" as const;
const SELLER_ACCOUNT = privateKeyToAccount(SELLER_KEY);
const SELLER_ID = SELLER_ACCOUNT.address.toLowerCase();

const OTHER_KEY =
  "0x4444444444444444444444444444444444444444444444444444444444444444" as const;
const OTHER_ACCOUNT = privateKeyToAccount(OTHER_KEY);

const BUYER_ID = "0x1234567890123456789012345678901234567890";

async function signCanonical(
  account: ReturnType<typeof privateKeyToAccount>,
  payload: object,
): Promise<`0x${string}`> {
  const canonical = JSON.stringify(payload, Object.keys(payload).sort());
  const hash = keccak256(toBytes(canonical));
  return account.signMessage({ message: { raw: hash } });
}

interface ReceiptInput {
  protocol_version: string;
  hire_id: string;
  agent_id: string;
  buyer: string;
  capability: string;
  capability_version?: string;
  amount_usdc_atomic: string;
  network: "base" | "base-sepolia";
  tx_hash: string;
  completed_at: string;
  verification: { all_passed: boolean; checks: Record<string, boolean> };
}

function makeReceiptInput(overrides: Partial<ReceiptInput> = {}): ReceiptInput {
  return {
    protocol_version: "swarmwage/v0.1",
    hire_id: `hire-${Math.random().toString(36).slice(2)}`,
    agent_id: SELLER_ID,
    buyer: BUYER_ID,
    capability: "audio.transcribe.json-with-timestamps",
    amount_usdc_atomic: "100000",
    network: "base-sepolia",
    tx_hash:
      "0xabababababababababababababababababababababababababababababababab",
    completed_at: new Date().toISOString(),
    verification: { all_passed: true, checks: { schema_ok: true } },
    ...overrides,
  };
}

async function post(app: ReturnType<typeof createApp>["app"], body: unknown) {
  const res = await app.request("/v1/receipts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, json };
}

describe("POST /v1/receipts", () => {
  let appHandle: ReturnType<typeof createApp>;

  before(() => {
    appHandle = createApp({ enableRequestLogger: false });
  });

  it("accepts a valid signed receipt and returns 200 + receipt_id", async () => {
    const input = makeReceiptInput();
    const signature = await signCanonical(SELLER_ACCOUNT, input);
    const { status, json } = await post(appHandle.app, { ...input, signature });
    assert.equal(status, 200, JSON.stringify(json));
    assert.equal(json.ok, true);
    assert.match(String(json.receipt_id), /^[0-9a-f-]{36}$/);
  });

  it("rejects a payload signed by a different wallet with 401", async () => {
    const input = makeReceiptInput();
    const wrongSignature = await signCanonical(OTHER_ACCOUNT, input);
    const { status, json } = await post(appHandle.app, {
      ...input,
      signature: wrongSignature,
    });
    assert.equal(status, 401);
    assert.equal(json.ok, false);
    assert.match(String(json.error), /Invalid signature/);
  });

  it("rejects a tampered payload (recovered address mismatches) with 401", async () => {
    const input = makeReceiptInput();
    const signature = await signCanonical(SELLER_ACCOUNT, input);
    const tampered = { ...input, amount_usdc_atomic: "999999999" };
    const { status } = await post(appHandle.app, { ...tampered, signature });
    assert.equal(status, 401);
  });

  it("returns 409 on duplicate (hire_id, agent_id)", async () => {
    const input = makeReceiptInput({ hire_id: "duplicate-hire-id-xyz" });
    const signature = await signCanonical(SELLER_ACCOUNT, input);

    const first = await post(appHandle.app, { ...input, signature });
    assert.equal(first.status, 200);

    // Re-submit identical payload — duplicate.
    const second = await post(appHandle.app, { ...input, signature });
    assert.equal(second.status, 409);
    assert.equal(second.json.error, "duplicate_hire_id");
    assert.equal(second.json.receipt_id, first.json.receipt_id);
  });

  it("returns 400 on bad shape (missing field)", async () => {
    const { status, json } = await post(appHandle.app, {
      protocol_version: "swarmwage/v0.1",
      // hire_id missing
      agent_id: SELLER_ID,
    });
    assert.equal(status, 400);
    assert.equal(json.ok, false);
  });

  it("returns 400 on tx_hash with wrong length", async () => {
    const input = makeReceiptInput({ tx_hash: "0xabcd" });
    const signature = await signCanonical(SELLER_ACCOUNT, input);
    const { status } = await post(appHandle.app, { ...input, signature });
    assert.equal(status, 400);
  });

  it("returns 400 when completed_at is older than 24h", async () => {
    const input = makeReceiptInput({
      completed_at: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
    });
    const signature = await signCanonical(SELLER_ACCOUNT, input);
    const { status, json } = await post(appHandle.app, { ...input, signature });
    assert.equal(status, 400);
    assert.match(String(json.error), /older than 24h/);
  });

  it("returns 400 when completed_at is far in the future", async () => {
    const input = makeReceiptInput({
      completed_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });
    const signature = await signCanonical(SELLER_ACCOUNT, input);
    const { status, json } = await post(appHandle.app, { ...input, signature });
    assert.equal(status, 400);
    assert.match(String(json.error), /future/);
  });

  it("returns 400 on invalid network enum", async () => {
    const input = makeReceiptInput();
    const signature = await signCanonical(SELLER_ACCOUNT, input);
    const { status } = await post(appHandle.app, {
      ...input,
      network: "ethereum",
      signature,
    });
    assert.equal(status, 400);
  });

  it("returns 400 on malformed JSON body", async () => {
    const res = await appHandle.app.request("/v1/receipts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not valid json",
    });
    assert.equal(res.status, 400);
  });
});
