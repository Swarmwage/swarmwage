// Swarmwage Facilitator — /settle resilience tests
// License: BUSL-1.1
//
// Verifies the route handler's defensive behaviour around the
// `relay.settleAuthorization` call:
//
//   1. Relay throws an unexpected error → handler catches it, writes a
//      best-effort audit row with `ok=false` and
//      `error=settle_unexpected_error`, returns HTTP 500 with a
//      controlled JSON body. No naked stack-trace leak, no missing log
//      row, no propagation to Hono's default error handler.
//   2. The `withTimeout` primitive resolves on prompt success and
//      rejects with `SettleTimeoutError` when the wrapped promise
//      hangs past the deadline. The integration ceiling is 60s in
//      production; testing it end-to-end through the route would mean
//      a 60s test, so we exercise the timer directly here.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import type { Account, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { GasGuard } from "../gas-guard.js";
import { createApp } from "../index.js";
import type { Relay } from "../relay.js";
import { __test__ as settleInternals } from "../routes/settle.js";
import { InMemoryStore } from "../store.js";

const { withTimeout, SettleTimeoutError } = settleInternals;

const DUMMY_KEY: Hex =
  "0x1111111111111111111111111111111111111111111111111111111111111111";

function buildSettleBody() {
  return {
    paymentPayload: {
      x402Version: 1,
      scheme: "exact",
      network: "base-sepolia",
      payload: {
        signature: "0x" + "1".repeat(130),
        authorization: {
          from: "0x000000000000000000000000000000000000beef",
          to: "0x000000000000000000000000000000000000cafe",
          value: "1000",
          validAfter: "0",
          validBefore: "9999999999",
          nonce: "0x" + "f".repeat(64),
        },
      },
    },
    paymentRequirements: {
      scheme: "exact",
      network: "base-sepolia",
      maxAmountRequired: "1000",
      resource: "https://example.com/r",
      description: "test",
      mimeType: "application/json",
      payTo: "0x000000000000000000000000000000000000cafe",
      maxTimeoutSeconds: 30,
      asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    },
  };
}

function buildThrowingRelay(message: string): Relay {
  const account: Account = privateKeyToAccount(DUMMY_KEY);
  return {
    network: "base-sepolia",
    chainId: 84_532,
    account,
    publicClient: {} as Relay["publicClient"],
    walletClient: {} as Relay["walletClient"],
    async gasBalance() {
      return 10n ** 18n; // well above any reserve floor
    },
    inFlightCount() {
      return 0;
    },
    async verifyAuthorization() {
      return { isValid: true, payer: "0xbeef" };
    },
    async settleAuthorization() {
      throw new Error(message);
    },
  };
}

test("/settle returns 500 + audit log when relay throws unexpectedly", async () => {
  const relay = buildThrowingRelay("boom: relay internals broke");
  const store = new InMemoryStore();
  const gasGuard = new GasGuard({ minReserveWei: 0n, maxPerHourWei: 0n });

  const app = createApp({ relay, store, gasGuard });
  const res = await app.request("/settle", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(buildSettleBody()),
  });
  assert.equal(res.status, 500);
  const body = (await res.json()) as Record<string, unknown>;
  assert.match(String(body.error), /unexpected error/i);

  // Audit row must be present so the failure is not invisible to analytics.
  const rows = store.snapshot();
  assert.equal(rows.length, 1);
  const row = rows[0]!;
  assert.equal(row.ok, false);
  assert.equal(row.error, "settle_unexpected_error");
  assert.equal(row.tx_hash, null);
  assert.equal(row.gas_eth_spent_wei, null);
  // Address fields populated from the parsed request payload, not the
  // (absent) relay response.
  assert.equal(
    row.payer_address,
    "0x000000000000000000000000000000000000beef",
  );
  assert.equal(
    row.recipient_address,
    "0x000000000000000000000000000000000000cafe",
  );
});

test("withTimeout: resolves with the value on prompt success", async () => {
  const result = await withTimeout(Promise.resolve("ok"), 1_000);
  assert.equal(result, "ok");
});

test("withTimeout: rejects with SettleTimeoutError when promise hangs", async () => {
  const hanging = new Promise<string>(() => {
    /* never resolves */
  });
  await assert.rejects(
    () => withTimeout(hanging, 50),
    (err: unknown) =>
      err instanceof SettleTimeoutError && err.name === "SettleTimeoutError",
  );
});

test("withTimeout: propagates the wrapped promise's own rejection", async () => {
  const failing = Promise.reject(new Error("inner failure"));
  await assert.rejects(
    () => withTimeout(failing, 1_000),
    (err: unknown) =>
      err instanceof Error &&
      !(err instanceof SettleTimeoutError) &&
      err.message === "inner failure",
  );
});

test("/settle 400s a scheme=exact payload missing authorization.from", async () => {
  // Proves the per-buyer rate-limit bypass concern is closed at the schema
  // boundary: x402's ExactEvmPayloadAuthorizationSchema declares `from` as
  // a required z.string(), so any request that reaches the rate-limit
  // branch with a defined buyerAddress has already been Zod-validated.
  // A missing-from payload is rejected before ever touching the relay.
  const relay = buildThrowingRelay("should never be called");
  const store = new InMemoryStore();
  const gasGuard = new GasGuard({ minReserveWei: 0n, maxPerHourWei: 0n });
  const app = createApp({ relay, store, gasGuard });

  const body = buildSettleBody();
  // Strip required `from` and `nonce` from the authorization. The schema
  // marks both as required strings; either omission triggers the 400.
  delete (body.paymentPayload.payload.authorization as Record<string, unknown>)
    .from;

  const res = await app.request("/settle", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  assert.equal(res.status, 400);
  // Relay must not have been touched — a 500 with empty store would
  // indicate the schema let the malformed payload through.
  assert.equal(store.snapshot().length, 0);
});
