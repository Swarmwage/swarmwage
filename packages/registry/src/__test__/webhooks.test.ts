// Swarmwage Registry — outbound webhook dispatch tests
// License: BUSL-1.1

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { keccak256, toBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { createApp } from "../app.js";
import {
  WebhookDispatcher,
  signWebhookBody,
  verifyWebhookSignature,
} from "../webhooks.js";

const SELLER_KEY =
  "0x5555555555555555555555555555555555555555555555555555555555555555" as const;
const SELLER_ACCOUNT = privateKeyToAccount(SELLER_KEY);
const SELLER_ID = SELLER_ACCOUNT.address.toLowerCase();
const BUYER_ID = "0x1234567890123456789012345678901234567890";
const SECRET = "test-secret-at-least-16-chars-long";

async function signCanonical(
  account: ReturnType<typeof privateKeyToAccount>,
  payload: object,
): Promise<`0x${string}`> {
  const canonical = JSON.stringify(payload, Object.keys(payload).sort());
  const hash = keccak256(toBytes(canonical));
  return account.signMessage({ message: { raw: hash } });
}

function makeReceiptInput(overrides: Record<string, unknown> = {}) {
  return {
    protocol_version: "swarmwage/v0.1",
    hire_id: `hire-${Math.random().toString(36).slice(2)}`,
    agent_id: SELLER_ID,
    buyer: BUYER_ID,
    capability: "chart.generate.from-data",
    amount_usdc_atomic: "50000",
    network: "base-sepolia" as const,
    tx_hash:
      "0xabababababababababababababababababababababababababababababababab",
    completed_at: new Date().toISOString(),
    verification: { all_passed: true, checks: { schema_ok: true } },
    ...overrides,
  };
}

describe("signWebhookBody / verifyWebhookSignature", () => {
  it("produces a sha256= prefixed hex string", () => {
    const sig = signWebhookBody("secret", "body");
    assert.match(sig, /^sha256=[0-9a-f]{64}$/);
  });

  it("verifies a matching signature", () => {
    const body = '{"event":"receipt.created"}';
    const sig = signWebhookBody(SECRET, body);
    assert.equal(verifyWebhookSignature(SECRET, body, sig), true);
  });

  it("rejects a tampered body", () => {
    const sig = signWebhookBody(SECRET, "original");
    assert.equal(verifyWebhookSignature(SECRET, "tampered", sig), false);
  });

  it("rejects a missing or malformed signature", () => {
    assert.equal(verifyWebhookSignature(SECRET, "body", undefined), false);
    assert.equal(verifyWebhookSignature(SECRET, "body", ""), false);
    assert.equal(verifyWebhookSignature(SECRET, "body", "deadbeef"), false);
    assert.equal(verifyWebhookSignature(SECRET, "body", "sha256=short"), false);
  });
});

describe("WebhookDispatcher disabled when no receivers", () => {
  it("enabled() returns false", () => {
    const d = new WebhookDispatcher({ receivers: [], secret: SECRET });
    assert.equal(d.enabled(), false);
  });

  it("fire() is a no-op", () => {
    const d = new WebhookDispatcher({ receivers: [], secret: SECRET });
    d.fire({
      event: "receipt.created",
      receipt_id: "rec_x",
      protocol_version: "v",
      hire_id: "h",
      agent_id: "0x" + "a".repeat(40),
      buyer: "0x" + "b".repeat(40),
      capability: "c",
      amount_usdc_atomic: "0",
      network: "base",
      tx_hash: ("0x" + "c".repeat(64)) as `0x${string}`,
      completed_at: new Date().toISOString(),
      verification_all_passed: true,
    });
  });
});

describe("POST /v1/receipts dispatches webhook with valid signature", () => {
  interface CapturedRequest {
    method: string;
    headers: Record<string, string>;
    body: string;
  }
  const captured: CapturedRequest[] = [];
  let serverUrl = "";
  let server: ReturnType<typeof createServer>;

  before(async () => {
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c as Buffer));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(req.headers)) {
          headers[k.toLowerCase()] = Array.isArray(v) ? v.join(",") : (v ?? "");
        }
        captured.push({ method: req.method ?? "", headers, body });
        res.statusCode = 204;
        res.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const addr = server.address() as AddressInfo;
    serverUrl = `http://127.0.0.1:${addr.port}/hook`;
  });

  after(() => {
    server.close();
  });

  it("delivers a signed receipt.created payload after successful POST", async () => {
    const dispatcher = new WebhookDispatcher({
      receivers: [{ url: serverUrl }],
      secret: SECRET,
      timeoutMs: 2_000,
    });
    const { app } = createApp({
      enableRequestLogger: false,
      webhookDispatcher: dispatcher,
    });

    const receiptInput = makeReceiptInput();
    const { verification, ...rest } = receiptInput;
    const canonicalPayload = { ...rest, verification };
    const signature = await signCanonical(SELLER_ACCOUNT, canonicalPayload);

    const res = await app.request("/v1/receipts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...receiptInput, signature }),
    });
    assert.equal(res.status, 200, await res.text());

    // Give the fire-and-forget dispatch a chance to land.
    const deadline = Date.now() + 2_000;
    while (captured.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.equal(captured.length, 1, "expected exactly one webhook delivery");

    const got = captured[0]!;
    assert.equal(got.method, "POST");
    assert.equal(got.headers["content-type"], "application/json");
    assert.equal(got.headers["x-webhook-event"], "receipt.created");
    assert.ok(got.headers["x-webhook-signature"]?.startsWith("sha256="));
    assert.ok(got.headers["x-webhook-timestamp"]);

    const valid = verifyWebhookSignature(
      SECRET,
      got.body,
      got.headers["x-webhook-signature"],
    );
    assert.equal(valid, true, "webhook signature should verify");

    const parsed = JSON.parse(got.body) as {
      event: string;
      receipt_id: string;
      agent_id: string;
      capability: string;
      verification_all_passed: boolean;
    };
    assert.equal(parsed.event, "receipt.created");
    assert.ok(parsed.receipt_id && parsed.receipt_id.length > 0);
    assert.equal(parsed.agent_id, SELLER_ID);
    assert.equal(parsed.capability, "chart.generate.from-data");
    assert.equal(parsed.verification_all_passed, true);
  });

  it("does not fire when dispatcher is omitted", async () => {
    captured.length = 0;
    const { app } = createApp({ enableRequestLogger: false });
    const receiptInput = makeReceiptInput({
      hire_id: `hire-no-webhook-${Math.random().toString(36).slice(2)}`,
    });
    const { verification, ...rest } = receiptInput;
    const signature = await signCanonical(SELLER_ACCOUNT, {
      ...rest,
      verification,
    });
    const res = await app.request("/v1/receipts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...receiptInput, signature }),
    });
    assert.equal(res.status, 200);
    // Give a small window — confirm nothing was captured.
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(captured.length, 0);
  });
});
