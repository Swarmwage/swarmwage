// Swarmwage Facilitator — smoke test
// License: BUSL-1.1
//
// Boots the Hono app with a mock relay and exercises the read-only routes
// (`/`, `/health`, `/supported`). On-chain `/verify` and `/settle` are out
// of scope here because they require a real RPC endpoint and a funded gas
// wallet.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import type { Account, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { createApp } from "../index.js";
import type { Relay } from "../relay.js";
import { InMemoryStore } from "../store.js";

const DUMMY_KEY: Hex =
  "0x1111111111111111111111111111111111111111111111111111111111111111";

function buildMockRelay(): Relay {
  const account: Account = privateKeyToAccount(DUMMY_KEY);
  return {
    network: "base-sepolia",
    chainId: 84_532,
    account,
    publicClient: {} as Relay["publicClient"],
    walletClient: {} as Relay["walletClient"],
    async gasBalance() {
      return 0n;
    },
    async verifyAuthorization() {
      return { isValid: false, invalidReason: "invalid_payload" };
    },
    async settleAuthorization() {
      return {
        response: {
          success: false,
          network: "base-sepolia",
          transaction: "",
          errorReason: "unexpected_settle_error",
        },
        gasSpentWei: null,
      };
    },
  };
}

function buildHarness() {
  const relay = buildMockRelay();
  const store = new InMemoryStore();
  const app = createApp({ relay, store });
  return { app, relay, store };
}

test("GET / returns service info", async () => {
  const { app } = buildHarness();
  const res = await app.request("/");
  assert.equal(res.status, 200);
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(body.name, "swarmwage-facilitator");
  assert.equal(body.role, "gas-relay-only x402 facilitator");
  assert.equal(body.network, "base-sepolia");
});

test("GET /health returns gas wallet info", async () => {
  const { app, relay } = buildHarness();
  const res = await app.request("/health");
  assert.equal(res.status, 200);
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(body.network, "base-sepolia");
  assert.equal(body.gas_wallet, relay.account.address);
  assert.equal(body.ok, true);
  assert.equal(body.eth_balance_wei, "0");
  // Default app harness has no gas guard configured, so /health reports a
  // permissive snapshot (caps disabled, reserve floor disabled, breach
  // false because the floor is also zero).
  const guard = body.gas_guard as Record<string, unknown>;
  assert.ok(guard);
  assert.equal(guard.hourly_used_wei, "0");
  assert.equal(guard.hourly_cap_wei, "0");
  assert.equal(guard.hourly_used_pct, null);
  assert.equal(guard.reserve_wei, "0");
  assert.equal(guard.reserve_breached, false);
});

test("GET /supported lists the active scheme + network", async () => {
  const { app } = buildHarness();
  const res = await app.request("/supported");
  assert.equal(res.status, 200);
  const body = (await res.json()) as { kinds: Array<Record<string, unknown>> };
  assert.equal(Array.isArray(body.kinds), true);
  assert.equal(body.kinds.length, 1);
  const [kind] = body.kinds;
  assert.equal(kind?.scheme, "exact");
  assert.equal(kind?.network, "base-sepolia");
  assert.equal(kind?.x402Version, 1);
});

test("POST /verify rejects malformed JSON", async () => {
  const { app } = buildHarness();
  const res = await app.request("/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{not-json",
  });
  assert.equal(res.status, 400);
});

test("POST /settle rejects requests with no body schema match", async () => {
  const { app } = buildHarness();
  const res = await app.request("/settle", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ paymentPayload: {}, paymentRequirements: {} }),
  });
  assert.equal(res.status, 400);
});
