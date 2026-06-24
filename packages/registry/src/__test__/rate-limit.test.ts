// Swarmwage Registry — clientIp trusted-proxy regression (P1-A, 2026-06-24).
// The per-IP flood guard must NOT trust client-controlled X-Forwarded-For /
// X-Real-IP unless the socket peer is a configured trusted proxy; otherwise an
// attacker rotates the header per request and defeats the bucket (same class
// as facilitator GH#7).
// License: BUSL-1.1

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Context } from "hono";

import { clientIp } from "../rate-limit.js";

/** Minimal Context shim — clientIp reads only c.req.header() and the socket. */
function ctx(
  headers: Record<string, string>,
  remoteAddress?: string,
): Context {
  return {
    req: { header: (name: string) => headers[name.toLowerCase()] },
    env: { incoming: { socket: { remoteAddress } } },
  } as unknown as Context;
}

test("clientIp: no trusted proxies — XFF ignored, socket wins", () => {
  const c = ctx({ "x-forwarded-for": "9.9.9.9", "x-real-ip": "8.8.8.8" }, "203.0.113.42");
  assert.equal(clientIp(c), "203.0.113.42");
  assert.equal(clientIp(c, new Set()), "203.0.113.42");
});

test("clientIp: socket not in trust list — XFF ignored", () => {
  const c = ctx({ "x-forwarded-for": "1.2.3.4" }, "203.0.113.99");
  assert.equal(clientIp(c, new Set(["127.0.0.1"])), "203.0.113.99");
});

test("clientIp: trusted proxy match — first XFF entry wins", () => {
  const c = ctx({ "x-forwarded-for": "1.2.3.4, 10.0.0.1" }, "127.0.0.1");
  assert.equal(clientIp(c, new Set(["127.0.0.1"])), "1.2.3.4");
});

test("clientIp: IPv4-mapped IPv6 socket normalizes for trust check", () => {
  const c = ctx({ "x-forwarded-for": "1.2.3.4" }, "::ffff:127.0.0.1");
  assert.equal(clientIp(c, new Set(["127.0.0.1"])), "1.2.3.4");
});

test("clientIp: attack — rotating XFF without proxy trust collapses to one key", () => {
  const trust = new Set(["127.0.0.1"]);
  const keys = new Set<string>();
  for (let i = 0; i < 100; i++) {
    // attacker connects directly (untrusted socket) and forges a fresh XFF
    keys.add(clientIp(ctx({ "x-forwarded-for": `192.0.2.${i}` }, "198.51.100.7"), trust));
  }
  assert.equal(keys.size, 1, "all forged-XFF requests must share one bucket");
});
