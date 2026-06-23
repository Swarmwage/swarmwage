// Swarmwage Agent SDK — receipt submission tests
// License: MIT

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { canonicalize } from "../canonical.js";

import {
  isReceiptsEnabled,
  signReceipt,
  submitReceipt,
  type ReceiptPayload,
} from "../receipts.js";
import { createWallet } from "../wallet.js";
import type { AgentId, Hex } from "../types.js";

// 32-byte test key (NOT a real wallet — used purely for local signing).
const TEST_PRIVATE_KEY: Hex =
  "0x2222222222222222222222222222222222222222222222222222222222222222";

const TEST_WALLET = createWallet({ privateKey: TEST_PRIVATE_KEY });
const SELLER_ID: AgentId = TEST_WALLET.agentId;

function makePayload(overrides: Partial<ReceiptPayload> = {}): ReceiptPayload {
  return {
    protocol_version: "swarmwage/v0.1",
    hire_id: "11111111-2222-3333-4444-555555555555",
    agent_id: SELLER_ID,
    buyer: "0x1234567890123456789012345678901234567890" as AgentId,
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

describe("isReceiptsEnabled", () => {
  it("returns true by default (env unset, opts undefined)", () => {
    assert.equal(isReceiptsEnabled(undefined, {}), true);
  });

  it("respects explicit `enabled: false` regardless of env", () => {
    assert.equal(isReceiptsEnabled(false, { SWARMWAGE_RECEIPTS: "1" }), false);
  });

  it("respects explicit `enabled: true` regardless of env", () => {
    assert.equal(isReceiptsEnabled(true, { SWARMWAGE_RECEIPTS: "0" }), true);
  });

  it("opts out via SWARMWAGE_RECEIPTS=0", () => {
    assert.equal(isReceiptsEnabled(undefined, { SWARMWAGE_RECEIPTS: "0" }), false);
  });

  it("opts out via SWARMWAGE_RECEIPTS=false (case-insensitive)", () => {
    assert.equal(
      isReceiptsEnabled(undefined, { SWARMWAGE_RECEIPTS: "False" }),
      false,
    );
  });

  it("opts out via SWARMWAGE_RECEIPTS=off|no", () => {
    assert.equal(
      isReceiptsEnabled(undefined, { SWARMWAGE_RECEIPTS: "off" }),
      false,
    );
    assert.equal(
      isReceiptsEnabled(undefined, { SWARMWAGE_RECEIPTS: "no" }),
      false,
    );
  });

  it("trims whitespace before parsing the env", () => {
    assert.equal(
      isReceiptsEnabled(undefined, { SWARMWAGE_RECEIPTS: "  0  " }),
      false,
    );
  });

  it("treats values like '1' or 'true' as ON", () => {
    assert.equal(
      isReceiptsEnabled(undefined, { SWARMWAGE_RECEIPTS: "1" }),
      true,
    );
    assert.equal(
      isReceiptsEnabled(undefined, { SWARMWAGE_RECEIPTS: "true" }),
      true,
    );
  });
});

describe("signReceipt", () => {
  it("produces a 0x-prefixed hex signature recoverable to the signer", async () => {
    const payload = makePayload();
    const { signature, body } = await signReceipt(TEST_WALLET, payload);
    assert.match(signature, /^0x[a-fA-F0-9]+$/);
    assert.equal(body.signature, signature);
    assert.equal(body.agent_id, SELLER_ID);
    // Round-trip recover via the same canonical scheme used server-side.
    const { recoverMessageAddress, keccak256, toBytes } = await import("viem");
    const { signature: _omit, ...rest } = body;
    const canonical = canonicalize(rest);
    const hash = keccak256(toBytes(canonical));
    const recovered = await recoverMessageAddress({
      message: { raw: hash },
      signature,
    });
    assert.equal(recovered.toLowerCase(), SELLER_ID.toLowerCase());
  });
});

describe("submitReceipt", () => {
  it("returns { submitted: false } when opted out via env", async () => {
    let called = 0;
    const fakeFetch = (async () => {
      called += 1;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const res = await submitReceipt({
      sellerPrivateKey: TEST_PRIVATE_KEY,
      payload: makePayload(),
      enabled: false,
      fetchImpl: fakeFetch,
    });
    assert.equal(res.submitted, false);
    assert.equal(called, 0);
  });

  it("posts a signed body and returns receipt_id on 200", async () => {
    let lastUrl: string | undefined;
    let lastInit: RequestInit | undefined;
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      lastUrl = url;
      lastInit = init;
      return new Response(
        JSON.stringify({ ok: true, receipt_id: "rcp_abc" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const res = await submitReceipt({
      registryUrl: "https://r.example.com/",
      sellerPrivateKey: TEST_PRIVATE_KEY,
      payload: makePayload(),
      fetchImpl: fakeFetch,
    });

    assert.equal(res.submitted, true);
    assert.equal(res.status, 200);
    assert.equal(res.receipt_id, "rcp_abc");
    assert.equal(lastUrl, "https://r.example.com/v1/receipts");
    assert.ok(lastInit?.body);
    const sent = JSON.parse(lastInit!.body as string);
    assert.match(sent.signature, /^0x[a-fA-F0-9]+$/);
    assert.equal(sent.agent_id, SELLER_ID);
  });

  it("does NOT throw on HTTP error — returns error in result", async () => {
    const fakeFetch = (async () =>
      new Response("nope", { status: 500 })) as unknown as typeof fetch;
    const res = await submitReceipt({
      sellerPrivateKey: TEST_PRIVATE_KEY,
      payload: makePayload(),
      fetchImpl: fakeFetch,
      logger: () => {},
    });
    assert.equal(res.submitted, true);
    assert.equal(res.status, 500);
    assert.ok(res.error);
  });

  it("does NOT throw on network exception — returns error in result", async () => {
    const fakeFetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const res = await submitReceipt({
      sellerPrivateKey: TEST_PRIVATE_KEY,
      payload: makePayload(),
      fetchImpl: fakeFetch,
      logger: () => {},
    });
    assert.equal(res.submitted, true);
    assert.match(res.error ?? "", /ECONNREFUSED/);
  });

  it("rejects payloads whose agent_id does not match the seller wallet", async () => {
    let called = 0;
    const fakeFetch = (async () => {
      called += 1;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const res = await submitReceipt({
      sellerPrivateKey: TEST_PRIVATE_KEY,
      payload: makePayload({
        agent_id: "0x9999999999999999999999999999999999999999" as AgentId,
      }),
      fetchImpl: fakeFetch,
      logger: () => {},
    });
    assert.equal(called, 0);
    assert.match(res.error ?? "", /does not match seller wallet/);
  });
});
