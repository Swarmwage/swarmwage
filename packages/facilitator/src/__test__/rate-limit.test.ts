// Swarmwage Facilitator — clientIp + rate-limiter unit tests
// License: BUSL-1.1
//
// Pins the trusted-proxy gate (GH issue #7): X-Forwarded-For and X-Real-IP
// are honored ONLY when the originating socket address is in the configured
// trusted-proxy set. Without this, an attacker rotates the header per
// request, defeats the per-IP bucket, and drains the gas bankroll.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import type { Context } from "hono";

import { clientIp } from "../rate-limit.js";

/**
 * Minimal Context shim — clientIp only reads two surfaces:
 *   - c.req.header(name) for "x-forwarded-for" / "x-real-ip"
 *   - c.env.incoming.socket.remoteAddress for the raw socket IP
 * Building a real Hono Context here would couple this test to internal
 * Hono types that may shift across minor versions; the shim is precisely
 * what the function under test consumes.
 */
function ctx(
  headers: Record<string, string>,
  remoteAddress: string | undefined,
): Context {
  return {
    req: {
      header(name: string): string | undefined {
        return headers[name.toLowerCase()];
      },
    },
    env: {
      incoming: { socket: { remoteAddress } },
    },
  } as unknown as Context;
}

test("clientIp: no trusted proxies — XFF is ignored, socket wins", () => {
  const c = ctx(
    { "x-forwarded-for": "9.9.9.9", "x-real-ip": "8.8.8.8" },
    "203.0.113.42",
  );
  assert.equal(clientIp(c), "203.0.113.42");
  assert.equal(clientIp(c, new Set()), "203.0.113.42");
});

test("clientIp: trusted proxy match — first XFF entry wins", () => {
  const c = ctx({ "x-forwarded-for": "1.2.3.4, 10.0.0.1" }, "127.0.0.1");
  assert.equal(clientIp(c, new Set(["127.0.0.1"])), "1.2.3.4");
});

test("clientIp: trusted proxy match, no XFF — X-Real-IP wins", () => {
  const c = ctx({ "x-real-ip": "5.6.7.8" }, "127.0.0.1");
  assert.equal(clientIp(c, new Set(["127.0.0.1"])), "5.6.7.8");
});

test("clientIp: socket not in trust list — XFF ignored", () => {
  // The attack from issue #7: random external IP sending X-Forwarded-For
  // headers. The header must NOT be trusted.
  const c = ctx({ "x-forwarded-for": "1.2.3.4" }, "203.0.113.99");
  assert.equal(clientIp(c, new Set(["127.0.0.1"])), "203.0.113.99");
});

test("clientIp: IPv4-mapped IPv6 socket normalizes for trust check", () => {
  // Node's HTTP socket frequently exposes loopback as ::ffff:127.0.0.1.
  // Operators configure plain 127.0.0.1 — the match must still succeed.
  const c = ctx(
    { "x-forwarded-for": "1.2.3.4" },
    "::ffff:127.0.0.1",
  );
  assert.equal(clientIp(c, new Set(["127.0.0.1"])), "1.2.3.4");
});

test("clientIp: IPv4-mapped IPv6 in XFF is normalized", () => {
  const c = ctx(
    { "x-forwarded-for": "::ffff:1.2.3.4" },
    "127.0.0.1",
  );
  assert.equal(clientIp(c, new Set(["127.0.0.1"])), "1.2.3.4");
});

test("clientIp: empty XFF entry falls through to X-Real-IP", () => {
  const c = ctx(
    { "x-forwarded-for": "   ", "x-real-ip": "9.9.9.9" },
    "127.0.0.1",
  );
  assert.equal(clientIp(c, new Set(["127.0.0.1"])), "9.9.9.9");
});

test("clientIp: no socket address falls back to 'unknown'", () => {
  const c = ctx({}, undefined);
  assert.equal(clientIp(c), "unknown");
  assert.equal(clientIp(c, new Set(["127.0.0.1"])), "unknown");
});

test("clientIp: attack scenario — rotating XFF without proxy trust", () => {
  // Concretizes the issue #7 attack: a single attacker sends N requests
  // from the same socket address, rotating X-Forwarded-For to a fresh
  // value each time. With the fix the limiter keys on the socket — all
  // N requests hit the same bucket. Without the fix each request lands
  // in its own bucket and the per-IP cap is bypassed.
  const ATTACKER_SOCKET = "198.51.100.7";
  const trust = new Set<string>(); // no proxy configured
  const ips: string[] = [];
  for (let i = 0; i < 10; i++) {
    const c = ctx(
      { "x-forwarded-for": `192.0.2.${i}` },
      ATTACKER_SOCKET,
    );
    ips.push(clientIp(c, trust));
  }
  // All 10 requests collapse to a single key — the rate limiter will
  // throttle them correctly.
  assert.equal(new Set(ips).size, 1);
  assert.equal(ips[0], ATTACKER_SOCKET);
});
