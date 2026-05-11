// Swarmwage Registry — POST /v1/search (exact + prefix) and GET /v1/listings
// public discovery semantics.
// License: BUSL-1.1

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { keccak256, toBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { createApp } from "../app.js";

const SELLER_KEY =
  "0x6666666666666666666666666666666666666666666666666666666666666666" as const;
const SELLER_ACCOUNT = privateKeyToAccount(SELLER_KEY);
const SELLER_ID = SELLER_ACCOUNT.address.toLowerCase();

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

interface SearchResponse {
  agents: Array<{
    agent_id: string;
    listing: { capability: string; price_usdc: string };
  }>;
  next_cursor: null;
  match?: string;
}

async function search(
  app: ReturnType<typeof createApp>["app"],
  body: Record<string, unknown>,
): Promise<{ status: number; json: SearchResponse }> {
  const res = await app.request("/v1/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as SearchResponse;
  return { status: res.status, json };
}

describe("POST /v1/search — exact vs prefix matching", () => {
  let appHandle: ReturnType<typeof createApp>;

  before(async () => {
    appHandle = createApp({ enableRequestLogger: false });
    // Three listings under `audio.transcribe.*`, one under `image.generate.*`.
    // Prefix `audio.transcribe` must match the first three only.
    const a = await postListing(
      appHandle.app,
      "audio.transcribe.json-with-timestamps",
      "0.10",
    );
    const b = await postListing(appHandle.app, "audio.transcribe.text", "0.05");
    const c = await postListing(
      appHandle.app,
      "audio.transcribe.srt",
      "0.07",
    );
    const d = await postListing(appHandle.app, "image.generate.png", "0.20");
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal(c.status, 200);
    assert.equal(d.status, 200);
  });

  it("exact match (default) returns only listings with capability === query", async () => {
    const { status, json } = await search(appHandle.app, {
      capability: "audio.transcribe.json-with-timestamps",
    });
    assert.equal(status, 200);
    assert.equal(json.agents.length, 1);
    assert.equal(
      json.agents[0]?.listing.capability,
      "audio.transcribe.json-with-timestamps",
    );
    // Backwards compat: with no `match` field, server still reports the
    // default it applied.
    assert.equal(json.match, "exact");
  });

  it("exact match still returns 0 results for marketed shorthand (regression)", async () => {
    // This is the production bug: searching `audio.transcribe` (the value
    // marketed on the landing) used to return nothing because no listing
    // has that EXACT capability string.
    const { status, json } = await search(appHandle.app, {
      capability: "audio.transcribe",
    });
    assert.equal(status, 200);
    assert.equal(json.agents.length, 0);
  });

  it("prefix match returns all listings whose capability starts with the query", async () => {
    const { status, json } = await search(appHandle.app, {
      capability: "audio.transcribe",
      match: "prefix",
    });
    assert.equal(status, 200);
    assert.equal(json.agents.length, 3);
    const caps = json.agents.map((a) => a.listing.capability).sort();
    assert.deepEqual(caps, [
      "audio.transcribe.json-with-timestamps",
      "audio.transcribe.srt",
      "audio.transcribe.text",
    ]);
    assert.equal(json.match, "prefix");
  });

  it("prefix match still honours other filters (max_price_usdc)", async () => {
    const { status, json } = await search(appHandle.app, {
      capability: "audio.transcribe",
      match: "prefix",
      max_price_usdc: "0.06",
    });
    assert.equal(status, 200);
    // Only `audio.transcribe.text` at 0.05 is <= 0.06.
    assert.equal(json.agents.length, 1);
    assert.equal(json.agents[0]?.listing.capability, "audio.transcribe.text");
  });

  it("prefix match does NOT cross capability boundaries", async () => {
    const { status, json } = await search(appHandle.app, {
      capability: "audio",
      match: "prefix",
    });
    assert.equal(status, 200);
    // All three audio.* listings, but NOT image.generate.png.
    assert.equal(json.agents.length, 3);
    for (const a of json.agents) {
      assert.ok(a.listing.capability.startsWith("audio"));
    }
  });

  it("rejects unknown match value with 400", async () => {
    const { status } = await search(appHandle.app, {
      capability: "audio.transcribe",
      match: "fuzzy",
    });
    assert.equal(status, 400);
  });

  it("rejects empty capability with 400", async () => {
    const { status } = await search(appHandle.app, { capability: "" });
    assert.equal(status, 400);
  });
});

describe("GET /v1/listings — public index when no recipient", () => {
  let appHandle: ReturnType<typeof createApp>;

  before(async () => {
    appHandle = createApp({ enableRequestLogger: false });
    await postListing(appHandle.app, "audio.transcribe.text", "0.05");
    await postListing(appHandle.app, "image.generate.png", "0.20");
  });

  it("returns a 200 documentation index instead of 400", async () => {
    const res = await appHandle.app.request("/v1/listings");
    assert.equal(res.status, 200);
    const json = (await res.json()) as {
      name: string;
      endpoint: string;
      capability_count: number;
      routes: Array<{ method: string; path: string }>;
      docs: string;
      examples: Record<string, { method: string; url: string; curl: string }>;
    };
    assert.equal(json.name, "swarmwage-registry");
    assert.equal(json.endpoint, "/v1/listings");
    assert.equal(json.capability_count, 2);
    // Routes manifest must include at least the search endpoint.
    const paths = json.routes.map((r) => `${r.method} ${r.path}`);
    assert.ok(paths.includes("POST /v1/search"), JSON.stringify(paths));
    assert.ok(paths.includes("GET /v1/listings"), JSON.stringify(paths));
    // Examples must include both exact and prefix search recipes.
    assert.ok(json.examples.search_exact);
    assert.ok(json.examples.search_prefix);
    assert.match(json.examples.search_prefix.curl, /prefix/);
    assert.match(json.docs, /SPEC\.md$/);
  });

  it("still returns 400 when recipient query is malformed", async () => {
    const res = await appHandle.app.request(
      "/v1/listings?recipient=not-an-address",
    );
    assert.equal(res.status, 400);
  });

  it("still returns 404 when recipient is well-formed but unknown", async () => {
    const res = await appHandle.app.request(
      "/v1/listings?recipient=0x0000000000000000000000000000000000000099",
    );
    assert.equal(res.status, 404);
  });
});

describe("GET / — root index", () => {
  it("includes routes manifest and docs link", async () => {
    const { app } = createApp({ enableRequestLogger: false });
    const res = await app.request("/");
    assert.equal(res.status, 200);
    const json = (await res.json()) as {
      name: string;
      protocol: string;
      docs: string;
      routes: Array<{ method: string; path: string }>;
    };
    assert.equal(json.name, "swarmwage-registry");
    assert.ok(json.protocol);
    assert.match(json.docs, /SPEC\.md$/);
    assert.ok(Array.isArray(json.routes));
    assert.ok(json.routes.length >= 5);
    const paths = json.routes.map((r) => `${r.method} ${r.path}`);
    assert.ok(paths.includes("POST /v1/search"));
  });
});
