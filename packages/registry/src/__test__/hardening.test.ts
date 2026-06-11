// Swarmwage Registry — hardening regressions from the 2026-06-12 review:
// malformed JSON must 400 (not 500), the per-agent publish rate limit must
// not be consumable by unauthenticated garbage-signature requests, and the
// publish limiter's bucket map must not grow unboundedly.
// License: BUSL-1.1

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { keccak256, toBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { createApp } from "../app.js";
import { PublishRateLimiter } from "../routes/listings.js";

const SELLER_KEY =
  "0x7777777777777777777777777777777777777777777777777777777777777777" as const;
const SELLER_ACCOUNT = privateKeyToAccount(SELLER_KEY);
const SELLER_ID = SELLER_ACCOUNT.address.toLowerCase();

async function signCanonical(payload: object): Promise<`0x${string}`> {
  const canonical = JSON.stringify(payload, Object.keys(payload).sort());
  const hash = keccak256(toBytes(canonical));
  return SELLER_ACCOUNT.signMessage({ message: { raw: hash } });
}

function listingPayload() {
  return {
    agent_id: SELLER_ID,
    capability: "custom.test.hardening",
    price_usdc: "0.05",
    currency: "USDC",
    chain: "base",
    max_latency_ms: 5000,
    first_call_free: false,
    endpoint: "https://seller.example/hardening",
  };
}

function postJson(app: ReturnType<typeof createApp>["app"], path: string, body: string) {
  return app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
}

describe("malformed JSON bodies return 400, not 500", () => {
  const { app } = createApp({ enableRequestLogger: false });
  const NOT_JSON = "{this is not json";

  for (const path of ["/v1/search", "/v1/listings", "/v1/claim", "/v1/claim/verify"]) {
    it(`POST ${path}`, async () => {
      const res = await postJson(app, path, NOT_JSON);
      assert.equal(res.status, 400);
      const body = (await res.json()) as { error: string };
      assert.match(body.error, /Invalid JSON/i);
    });
  }

  it("POST /telemetry swallows malformed JSON with 204 (never retry-loops old SDKs)", async () => {
    const res = await postJson(app, "/telemetry", NOT_JSON);
    assert.equal(res.status, 204);
  });
});

describe("per-agent publish rate limit is signature-gated", () => {
  it("garbage-signature publishes (401) do not consume the victim's bucket", async () => {
    const { app } = createApp({ enableRequestLogger: false });

    // An attacker who knows the victim's public agent_id floods publishes
    // with well-formed but invalid signatures. Before the fix these
    // consumed the per-agent bucket and locked the real seller out.
    for (let i = 0; i < 15; i++) {
      const res = await postJson(
        app,
        "/v1/listings",
        JSON.stringify({
          ...listingPayload(),
          signature: "0x" + "ab".repeat(65),
        }),
      );
      assert.equal(res.status, 401, `garbage publish #${i} must be rejected as unauthorized`);
    }

    // The legitimate seller publishes right after the flood — must succeed.
    const payload = listingPayload();
    const signature = await signCanonical(payload);
    const res = await postJson(
      app,
      "/v1/listings",
      JSON.stringify({ ...payload, signature }),
    );
    assert.equal(res.status, 200, "victim's signed publish must not be rate-limited by the flood");
  });

  it("signature-valid publishes are still limited to the 10-burst per agent", async () => {
    const { app } = createApp({ enableRequestLogger: false });
    const payload = listingPayload();
    const signature = await signCanonical(payload);
    const body = JSON.stringify({ ...payload, signature });

    let saw429 = false;
    for (let i = 0; i < 12; i++) {
      const res = await postJson(app, "/v1/listings", body);
      if (res.status === 429) {
        saw429 = true;
        assert.ok(res.headers.get("Retry-After"), "429 must carry Retry-After");
        break;
      }
      assert.equal(res.status, 200);
    }
    assert.ok(saw429, "the 11th+ publish in a minute must hit the per-agent limit");
  });
});

describe("PublishRateLimiter bucket eviction", () => {
  it("drops buckets idle past the GC cutoff instead of growing forever", (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
    const limiter = new PublishRateLimiter();

    // 1023 distinct agent_ids — one bucket each, no GC pass yet (GC runs
    // every 1024th consume).
    for (let i = 0; i < 1023; i++) {
      limiter.consume(`0xagent${i}`);
    }
    assert.equal(limiter.size(), 1023);

    // Advance past the 10-minute idle cutoff; the 1024th consume triggers
    // the GC pass, which must sweep all the stale buckets.
    t.mock.timers.tick(11 * 60 * 1000);
    limiter.consume("0xfresh");
    assert.ok(
      limiter.size() <= 2,
      `stale buckets must be evicted (size=${limiter.size()})`,
    );
  });
});
