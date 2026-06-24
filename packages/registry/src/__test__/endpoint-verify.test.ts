// Swarmwage Registry — endpoint ownership proof tests (Wave 2a)
// License: BUSL-1.1

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { keccak256, toBytes } from "viem";
import { canonicalize } from "@swarmwage/agent-sdk";
import { privateKeyToAccount } from "viem/accounts";

import { challengeEndpointOwnership } from "../endpoint-verify.js";
import { createApp } from "../app.js";
import type { AgentId, Hex } from "@swarmwage/agent-sdk";

const KEY =
  "0x5555555555555555555555555555555555555555555555555555555555555555" as const;
const ACCOUNT = privateKeyToAccount(KEY);
const AGENT_ID = ACCOUNT.address.toLowerCase() as AgentId;
const ENDPOINT = "https://seller.example/hire";

async function signCanonical(payload: object): Promise<Hex> {
  const canonical = canonicalize(payload);
  const hash = keccak256(toBytes(canonical));
  return ACCOUNT.signMessage({ message: { raw: hash } });
}

/** Build a fetch stub that returns a fixed response body + status. */
function stubFetch(handler: (url: string) => Promise<Response> | Response) {
  return async (input: string | URL | Request): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    return handler(url);
  };
}

describe("challengeEndpointOwnership", () => {
  it("returns ok=true when the endpoint signs the nonce correctly", async () => {
    const nonce = "deterministic-nonce-001";
    const fetchFn = stubFetch(async (url) => {
      // The challenger appends ?nonce=… — sanity check it's present.
      assert.ok(url.includes("/.well-known/swarmwage-verify"));
      assert.ok(url.includes(`nonce=${nonce}`));
      const signature = await signCanonical({ agent_id: AGENT_ID, nonce });
      return new Response(
        JSON.stringify({ agent_id: AGENT_ID, nonce, signature }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const result = await challengeEndpointOwnership(ENDPOINT, AGENT_ID, {
      fetchFn,
      nonceFn: () => nonce,
    });
    assert.deepEqual(result, { ok: true });
  });

  it("returns ok=false when the agent_id in the response doesn't match", async () => {
    const nonce = "nonce-other-agent";
    const otherAgent =
      "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef" as AgentId;
    const fetchFn = stubFetch(async () => {
      const signature = await signCanonical({
        agent_id: otherAgent,
        nonce,
      });
      return new Response(
        JSON.stringify({ agent_id: otherAgent, nonce, signature }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const result = await challengeEndpointOwnership(ENDPOINT, AGENT_ID, {
      fetchFn,
      nonceFn: () => nonce,
    });
    assert.equal(result.ok, false);
    assert.match(
      (result as { ok: false; reason: string }).reason,
      /agent_id does not match/,
    );
  });

  it("returns ok=false when the nonce echoes wrong", async () => {
    const issued = "nonce-issued";
    const echoed = "nonce-tampered";
    const fetchFn = stubFetch(async () => {
      const signature = await signCanonical({
        agent_id: AGENT_ID,
        nonce: echoed,
      });
      return new Response(
        JSON.stringify({ agent_id: AGENT_ID, nonce: echoed, signature }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const result = await challengeEndpointOwnership(ENDPOINT, AGENT_ID, {
      fetchFn,
      nonceFn: () => issued,
    });
    assert.equal(result.ok, false);
    assert.match(
      (result as { ok: false; reason: string }).reason,
      /nonce does not match/,
    );
  });

  it("returns ok=false when the signature doesn't verify", async () => {
    const nonce = "nonce-bad-sig";
    const fetchFn = stubFetch(
      async () =>
        new Response(
          JSON.stringify({
            agent_id: AGENT_ID,
            nonce,
            // 65 zeros = syntactically valid but cryptographically meaningless
            signature:
              "0x00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const result = await challengeEndpointOwnership(ENDPOINT, AGENT_ID, {
      fetchFn,
      nonceFn: () => nonce,
    });
    assert.equal(result.ok, false);
    assert.match(
      (result as { ok: false; reason: string }).reason,
      /signature does not verify/,
    );
  });

  it("returns ok=false when the endpoint returns non-2xx", async () => {
    const fetchFn = stubFetch(
      () => new Response("not found", { status: 404 }),
    );
    const result = await challengeEndpointOwnership(ENDPOINT, AGENT_ID, {
      fetchFn,
      nonceFn: () => "n",
    });
    assert.equal(result.ok, false);
    assert.match(
      (result as { ok: false; reason: string }).reason,
      /HTTP 404/,
    );
  });

  it("returns ok=false when the endpoint is unreachable", async () => {
    const fetchFn = stubFetch(() => {
      throw new Error("connect ECONNREFUSED");
    });
    const result = await challengeEndpointOwnership(ENDPOINT, AGENT_ID, {
      fetchFn,
      nonceFn: () => "n",
    });
    assert.equal(result.ok, false);
    assert.match(
      (result as { ok: false; reason: string }).reason,
      /unreachable/,
    );
  });

  it("SSRF guard: rejects (before any fetch) when the host resolves to a private IP", async () => {
    let fetched = false;
    const fetchFn = stubFetch(async () => {
      fetched = true;
      return new Response("{}", { status: 200 });
    });
    const result = await challengeEndpointOwnership(ENDPOINT, AGENT_ID, {
      fetchFn,
      nonceFn: () => "n",
      resolveFn: async () => ["10.0.0.9"],
    });
    assert.equal(result.ok, false);
    assert.match(
      (result as { ok: false; reason: string }).reason,
      /forbidden IP 10\.0\.0\.9 \(SSRF guard\)/,
    );
    assert.equal(fetched, false, "must not issue the request to a forbidden host");
  });

  it("SSRF guard: rejects a 3xx redirect instead of following it", async () => {
    const fetchFn = stubFetch(
      () =>
        new Response(null, {
          status: 302,
          headers: { location: "http://169.254.169.254/latest/meta-data/" },
        }),
    );
    const result = await challengeEndpointOwnership(ENDPOINT, AGENT_ID, {
      fetchFn,
      nonceFn: () => "n",
    });
    assert.equal(result.ok, false);
    assert.match(
      (result as { ok: false; reason: string }).reason,
      /redirected.*SSRF guard/,
    );
  });

  it("rejects an over-sized verify response body", async () => {
    const huge = "x".repeat(20 * 1024); // > 16KB cap
    const fetchFn = stubFetch(
      () => new Response(huge, { status: 200 }),
    );
    const result = await challengeEndpointOwnership(ENDPOINT, AGENT_ID, {
      fetchFn,
      nonceFn: () => "n",
    });
    assert.equal(result.ok, false);
    assert.match(
      (result as { ok: false; reason: string }).reason,
      /too large/,
    );
  });
});

describe("POST /v1/listings — endpointVerifyMode integration", () => {
  async function postListing(
    appHandle: ReturnType<typeof createApp>,
    overrides: Partial<{
      capability: string;
      endpoint: string;
    }> = {},
  ) {
    const listingPayload = {
      agent_id: AGENT_ID,
      capability: overrides.capability ?? "test.endpoint.verify",
      price_usdc: "0.01",
      currency: "USDC" as const,
      chain: "base" as const,
      max_latency_ms: 5000,
      first_call_free: false,
      endpoint: overrides.endpoint ?? ENDPOINT,
    };
    const signature = await signCanonical(listingPayload);
    const body = { ...listingPayload, signature };
    const res = await appHandle.app.request("/v1/listings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return {
      status: res.status,
      json: (await res.json().catch(() => ({}))) as Record<string, unknown>,
    };
  }

  it("skips the verify challenge when mode=off (default)", async () => {
    const appHandle = createApp({ enableRequestLogger: false });
    // Note: no fetchFn supplied — if mode were on it would try the real network
    const { status, json } = await postListing(appHandle);
    assert.equal(status, 200);
    assert.equal(json.ok, true);
  });

  it("enforces and rejects when mode=enforce and the challenge fails", async () => {
    const fetchFn = stubFetch(
      () => new Response("nope", { status: 404 }),
    );
    const appHandle = createApp({
      enableRequestLogger: false,
      endpointVerifyMode: "enforce",
      endpointVerifyOverrides: { fetchFn, nonceFn: () => "n-enforce" },
    });
    const { status, json } = await postListing(appHandle);
    assert.equal(status, 400);
    assert.match(
      String(json.error ?? ""),
      /endpoint ownership proof failed/,
    );
  });

  it("accepts even on failed challenge when mode=soft (warn only)", async () => {
    const fetchFn = stubFetch(
      () => new Response("nope", { status: 404 }),
    );
    const appHandle = createApp({
      enableRequestLogger: false,
      endpointVerifyMode: "soft",
      endpointVerifyOverrides: { fetchFn, nonceFn: () => "n-soft" },
    });
    const { status, json } = await postListing(appHandle);
    assert.equal(status, 200);
    assert.equal(json.ok, true);
  });

  it("accepts in enforce mode when the seller signs the nonce correctly", async () => {
    const nonce = "n-good-enforce";
    const fetchFn = stubFetch(async () => {
      const signature = await signCanonical({ agent_id: AGENT_ID, nonce });
      return new Response(
        JSON.stringify({ agent_id: AGENT_ID, nonce, signature }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const appHandle = createApp({
      enableRequestLogger: false,
      endpointVerifyMode: "enforce",
      endpointVerifyOverrides: { fetchFn, nonceFn: () => nonce },
    });
    const { status, json } = await postListing(appHandle);
    assert.equal(status, 200);
    assert.equal(json.ok, true);
  });
});
