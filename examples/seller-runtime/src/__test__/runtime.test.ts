// Swarmwage example seller runtime — behavioral contracts
// License: MIT

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { privateKeyToAccount } from "viem/accounts";
import { ENDPOINT_VERIFY_PATH } from "@swarmwage/agent-sdk";
import {
  createSellerRuntime,
  priceUsdcToAtomic,
} from "../index.js";

const PRIVATE_KEY = `0x${"01".repeat(32)}` as `0x${string}`;
const BUYER_A = "0x1111111111111111111111111111111111111111";
const BUYER_B = "0x2222222222222222222222222222222222222222";
const originalReceipts = process.env.SWARMWAGE_RECEIPTS;

before(() => {
  process.env.SWARMWAGE_RECEIPTS = "0";
});

after(() => {
  if (originalReceipts === undefined) delete process.env.SWARMWAGE_RECEIPTS;
  else process.env.SWARMWAGE_RECEIPTS = originalReceipts;
});

function runtime(overrides?: { perIp?: number; maxDailyHires?: number }) {
  return createSellerRuntime({
    identity: { privateKey: PRIVATE_KEY, serviceName: "seller-contract" },
    listing: {
      capability: "custom.test.echo",
      priceUsdc: "0.1234569",
      maxLatencyMs: 1000,
      firstCallFree: true,
      publicUrl: "http://localhost:4999",
      registryUrl: "http://localhost:3999",
      publishedMessage: "published\n",
    },
    payment: {
      network: "base-sepolia",
      facilitatorUrl: "https://x402.org/facilitator",
    },
    limits: {
      perIp: overrides?.perIp ?? 10,
      windowMs: 60_000,
      maxDailyHires: overrides?.maxDailyHires ?? 10,
      maxDailySpendUsd: 10,
      estimatedUpstreamUsd: 0,
    },
    metadata: { backend: "contract" },
    async fulfill(params) {
      return {
        result: params,
        verification: {
          checks: [{ name: "echoed", passed: true }],
          all_passed: true,
        },
      };
    },
  });
}

function hire(buyerId: string, headers?: Record<string, string>) {
  return new Request("http://seller.test/hire", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({
      protocol: "swarmwage/v0.1",
      buyer_id: buyerId,
      capability: "custom.test.echo",
      params: { value: 1 },
    }),
  });
}

describe("seller runtime contracts", () => {
  it("preserves six-decimal truncation for USDC atomic values", () => {
    assert.equal(priceUsdcToAtomic("0.1234569"), "123456");
    assert.equal(priceUsdcToAtomic("1"), "1000000");
    assert.equal(priceUsdcToAtomic("0.00"), "0");
  });

  it("returns the stable root metadata and ownership proof", async () => {
    const seller = runtime();
    const root = await seller.app.request("/");
    assert.deepEqual(await root.json(), {
      name: "swarmwage seller — custom.test.echo",
      agent_id: seller.agentId,
      protocol: "swarmwage/v0.1",
      backend: "contract",
    });

    const nonce = "contract-nonce";
    const proof = await seller.app.request(
      `${ENDPOINT_VERIFY_PATH}?nonce=${nonce}`,
    );
    assert.equal(proof.status, 200);
    const payload = (await proof.json()) as {
      agent_id: string;
      nonce: string;
      signature: string;
    };
    assert.equal(payload.agent_id, privateKeyToAccount(PRIVATE_KEY).address.toLowerCase());
    assert.equal(payload.nonce, nonce);
    assert.match(payload.signature, /^0x[0-9a-f]+$/);
  });

  it("keeps protocol/capability errors and the success envelope stable", async () => {
    const seller = runtime();
    const bad = await seller.app.request("/hire", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        protocol: "wrong",
        buyer_id: BUYER_A,
        capability: "custom.test.echo",
      }),
    });
    assert.equal(bad.status, 400);
    assert.deepEqual(await bad.json(), { error: "Unsupported protocol: wrong" });

    const ok = await seller.app.request(hire(BUYER_B));
    assert.equal(ok.status, 200);
    const body = (await ok.json()) as Record<string, unknown>;
    assert.equal(body.protocol, "swarmwage/v0.1");
    assert.deepEqual(body.result, { value: 1 });
    assert.equal(
      (body.receipt as { first_call_free: boolean }).first_call_free,
      true,
    );
  });

  it("runs rate limiting before payment", async () => {
    const seller = runtime({ perIp: 1 });
    assert.equal((await seller.app.request(hire(BUYER_A))).status, 200);
    const limited = await seller.app.request(hire(BUYER_B));
    assert.equal(limited.status, 429);
    assert.deepEqual(await limited.json(), {
      error: "Too many requests",
      retry_after_seconds: 60,
    });
  });

  it("runs the daily budget guard before payment", async () => {
    const seller = runtime({ maxDailyHires: 1 });
    assert.equal(
      (
        await seller.app.request(
          hire(BUYER_A, { "x-forwarded-for": "198.51.100.1" }),
        )
      ).status,
      200,
    );
    const exhausted = await seller.app.request(
      hire(BUYER_B, { "x-forwarded-for": "198.51.100.2" }),
    );
    assert.equal(exhausted.status, 503);
    const body = (await exhausted.json()) as { error: string; reason: string };
    assert.equal(body.error, "Daily budget exceeded");
    assert.equal(body.reason, "daily hire cap reached (1)");
  });
});
