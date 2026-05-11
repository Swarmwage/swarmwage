// Smoke tests for the firstCallFreeGate middleware + in-memory tracker.
// License: MIT
//
// Run with: pnpm exec tsx src/__test__/first-call-free.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Hono, type Context, type MiddlewareHandler } from "hono";

import { firstCallFreeGate, inMemoryTracker } from "../first-call-free.js";

const BUYER = "0xabcdef0123456789abcdef0123456789abcdef01";
const BUYER_2 = "0x1111111111111111111111111111111111111111";

type TestVars = { freeCall?: boolean; freeCallBuyerId?: string };
type TestApp = Hono<{ Variables: TestVars }>;

// Stand-in for x402-hono's paymentMiddleware: always returns 402 without
// checking anything. If the gate bypasses correctly, this is never invoked
// and the handler returns 200; if it falls through, we see 402 here.
function fakePaymentMiddleware(): MiddlewareHandler {
  return async (c: Context) => {
    return c.json({ accepts: [] }, 402);
  };
}

function buildApp() {
  const tracker = inMemoryTracker();
  const app = new Hono<{ Variables: TestVars }>();
  const pmw = fakePaymentMiddleware();
  app.use("/hire", firstCallFreeGate({ paymentMiddleware: pmw, tracker }));
  app.post("/hire", async (c) => {
    const freeCall = c.get("freeCall") === true;
    return c.json({ ok: true, freeCall });
  });
  return { app, tracker };
}

async function postHire(app: TestApp, buyer_id: string | undefined) {
  return app.request("/hire", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ buyer_id, capability: "image.generate" }),
  });
}

describe("firstCallFreeGate", () => {
  it("bypasses paymentMiddleware on the first hire from a buyer", async () => {
    const { app, tracker } = buildApp();
    const res = await postHire(app, BUYER);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; freeCall: boolean };
    assert.equal(body.freeCall, true);
    // Tracker is still empty until the handler marks the buyer as seen.
    assert.equal(tracker.has(BUYER), false);
  });

  it("falls back to paymentMiddleware on a repeat buyer", async () => {
    const { app, tracker } = buildApp();
    tracker.markSeen(BUYER);
    const res = await postHire(app, BUYER);
    assert.equal(res.status, 402);
  });

  it("isolates buyers — buyer A's mark does not consume buyer B's free call", async () => {
    const { app, tracker } = buildApp();
    tracker.markSeen(BUYER);
    const res = await postHire(app, BUYER_2);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; freeCall: boolean };
    assert.equal(body.freeCall, true);
  });

  it("does not bypass when buyer_id is missing — falls through to payment", async () => {
    const { app } = buildApp();
    const res = await postHire(app, undefined);
    assert.equal(res.status, 402);
  });

  it("treats buyer_id case-insensitively", async () => {
    const { app, tracker } = buildApp();
    tracker.markSeen(BUYER.toLowerCase());
    const res = await postHire(app, BUYER.toUpperCase());
    assert.equal(res.status, 402);
  });
});

describe("inMemoryTracker", () => {
  it("markSeen is idempotent", () => {
    const t = inMemoryTracker();
    t.markSeen(BUYER);
    t.markSeen(BUYER);
    assert.equal(t.has(BUYER), true);
  });

  it("reset clears all tracked buyers", () => {
    const t = inMemoryTracker();
    t.markSeen(BUYER);
    t.markSeen(BUYER_2);
    t.reset();
    assert.equal(t.has(BUYER), false);
    assert.equal(t.has(BUYER_2), false);
  });
});
