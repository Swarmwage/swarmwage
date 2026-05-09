// Swarmwage Facilitator — gas budget kill-switch tests
// License: BUSL-1.1
//
// Two scopes:
//   1. Unit tests on the GasGuard class (allowance accounting, reserve
//      check, disable-via-zero, sliding window pruning).
//   2. An integration test on the /settle route that exercises the 503
//      paths (hourly cap exhausted, reserve floor breached) without
//      hitting a real RPC or signing real authorizations.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import type { Account, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { GasGuard } from "../gas-guard.js";
import { createApp } from "../index.js";
import type { Relay } from "../relay.js";
import { InMemoryStore } from "../store.js";

const DUMMY_KEY: Hex =
  "0x1111111111111111111111111111111111111111111111111111111111111111";

const ONE_GWEI = 1_000_000_000n;
const ONE_FINNEY = 1_000_000_000_000_000n; // 0.001 ETH

// ---------------------------------------------------------------------------
// Unit tests — GasGuard
// ---------------------------------------------------------------------------

test("GasGuard.hourlyAllowance: allowed when no spend recorded", () => {
  const guard = new GasGuard({
    minReserveWei: ONE_FINNEY,
    maxPerHourWei: 10n * ONE_FINNEY,
  });
  const decision = guard.hourlyAllowance();
  assert.equal(decision.allowed, true);
  if (decision.allowed) {
    assert.equal(decision.spentWei, 0n);
    assert.equal(decision.capWei, 10n * ONE_FINNEY);
  }
});

test("GasGuard.hourlyAllowance: allowed when spend below cap", () => {
  const guard = new GasGuard({
    minReserveWei: 0n,
    maxPerHourWei: 1000n * ONE_GWEI,
  });
  guard.record(100n * ONE_GWEI);
  guard.record(200n * ONE_GWEI);
  const decision = guard.hourlyAllowance();
  assert.equal(decision.allowed, true);
  if (decision.allowed) {
    assert.equal(decision.spentWei, 300n * ONE_GWEI);
  }
});

test("GasGuard.hourlyAllowance: refused when spend at or above cap", () => {
  const guard = new GasGuard({
    minReserveWei: 0n,
    maxPerHourWei: 100n * ONE_GWEI,
  });
  guard.record(60n * ONE_GWEI);
  guard.record(50n * ONE_GWEI);
  const decision = guard.hourlyAllowance();
  assert.equal(decision.allowed, false);
  if (!decision.allowed) {
    assert.equal(decision.spentWei, 110n * ONE_GWEI);
    assert.equal(decision.capWei, 100n * ONE_GWEI);
    assert.ok(decision.retryAfterSec >= 1);
  }
});

test("GasGuard.hourlyAllowance: cap of 0n disables the cap", () => {
  const guard = new GasGuard({
    minReserveWei: 0n,
    maxPerHourWei: 0n,
  });
  guard.record(10n ** 18n); // 1 ETH burned
  const decision = guard.hourlyAllowance();
  assert.equal(decision.allowed, true);
});

test("GasGuard.hourlyAllowance: prunes entries older than the window", () => {
  const guard = new GasGuard({
    minReserveWei: 0n,
    maxPerHourWei: 100n * ONE_GWEI,
    windowMs: 50,
  });
  guard.record(80n * ONE_GWEI);
  // Wait past the window; spend should fall out.
  return new Promise<void>((resolve) => {
    setTimeout(() => {
      const decision = guard.hourlyAllowance();
      assert.equal(decision.allowed, true);
      if (decision.allowed) assert.equal(decision.spentWei, 0n);
      assert.equal(guard.size(), 0);
      resolve();
    }, 80);
  });
});

test("GasGuard.reserveCheck: allowed when balance at or above floor", () => {
  const guard = new GasGuard({
    minReserveWei: ONE_FINNEY,
    maxPerHourWei: 0n,
  });
  assert.equal(guard.reserveCheck(ONE_FINNEY).allowed, true);
  assert.equal(guard.reserveCheck(ONE_FINNEY * 2n).allowed, true);
});

test("GasGuard.reserveCheck: refused when balance below floor", () => {
  const guard = new GasGuard({
    minReserveWei: ONE_FINNEY,
    maxPerHourWei: 0n,
  });
  const decision = guard.reserveCheck(ONE_FINNEY - 1n);
  assert.equal(decision.allowed, false);
  if (!decision.allowed) {
    assert.equal(decision.minReserveWei, ONE_FINNEY);
    assert.equal(decision.balanceWei, ONE_FINNEY - 1n);
  }
});

test("GasGuard.reserveCheck: floor of 0n disables the reserve", () => {
  const guard = new GasGuard({
    minReserveWei: 0n,
    maxPerHourWei: 0n,
  });
  assert.equal(guard.reserveCheck(0n).allowed, true);
});

test("GasGuard.record: ignores zero and negative spends", () => {
  const guard = new GasGuard({
    minReserveWei: 0n,
    maxPerHourWei: ONE_GWEI,
  });
  guard.record(0n);
  guard.record(-1n);
  assert.equal(guard.size(), 0);
  assert.equal(guard.currentSpendWei(), 0n);
});

// ---------------------------------------------------------------------------
// Integration tests — /settle 503 paths
// ---------------------------------------------------------------------------

function buildMockRelay(opts: {
  gasBalanceWei?: bigint;
  gasBalanceThrows?: boolean;
}): Relay {
  const account: Account = privateKeyToAccount(DUMMY_KEY);
  const balance = opts.gasBalanceWei ?? ONE_FINNEY;
  return {
    network: "base-sepolia",
    chainId: 84_532,
    account,
    publicClient: {} as Relay["publicClient"],
    walletClient: {} as Relay["walletClient"],
    async gasBalance() {
      if (opts.gasBalanceThrows) throw new Error("rpc unreachable");
      return balance;
    },
    async verifyAuthorization() {
      return { isValid: true, payer: "0xbeef" };
    },
    async settleAuthorization() {
      // Should never reach here when the kill-switch is tripped.
      return {
        response: {
          success: true,
          network: "base-sepolia",
          transaction: ("0x" + "a".repeat(64)) as Hex,
          payer: "0xbeef",
        },
        gasSpentWei: ONE_GWEI,
      };
    },
  };
}

// Body shaped to pass FacilitatorRequestBodySchema. Values are placeholder —
// the mock relay does not actually call out to the chain.
function buildSettleBody() {
  return {
    paymentPayload: {
      x402Version: 1,
      scheme: "exact",
      network: "base-sepolia",
      payload: {
        signature:
          "0x" + "1".repeat(130),
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
      asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", // USDC base-sepolia
    },
  };
}

test("/settle returns 503 when hourly gas cap is exhausted", async () => {
  const relay = buildMockRelay({});
  const store = new InMemoryStore();
  const gasGuard = new GasGuard({
    minReserveWei: 0n,
    maxPerHourWei: 100n * ONE_GWEI,
  });
  // Pre-fill the window with spend that exhausts the cap.
  gasGuard.record(150n * ONE_GWEI);

  const app = createApp({ relay, store, gasGuard });
  const res = await app.request("/settle", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(buildSettleBody()),
  });
  assert.equal(res.status, 503);
  const body = (await res.json()) as Record<string, unknown>;
  assert.match(String(body.error), /gas budget/i);
  assert.ok(typeof body.retry_after_seconds === "number");
  assert.ok(res.headers.get("Retry-After"));
});

test("/settle returns 503 when gas balance is below reserve floor", async () => {
  const relay = buildMockRelay({ gasBalanceWei: ONE_FINNEY - 1n });
  const store = new InMemoryStore();
  const gasGuard = new GasGuard({
    minReserveWei: ONE_FINNEY,
    maxPerHourWei: 0n,
  });

  const app = createApp({ relay, store, gasGuard });
  const res = await app.request("/settle", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(buildSettleBody()),
  });
  assert.equal(res.status, 503);
  const body = (await res.json()) as Record<string, unknown>;
  assert.match(String(body.error), /reserve/i);
});

test("/settle returns 503 when balance RPC throws (fail-closed)", async () => {
  const relay = buildMockRelay({ gasBalanceThrows: true });
  const store = new InMemoryStore();
  const gasGuard = new GasGuard({
    minReserveWei: ONE_FINNEY,
    maxPerHourWei: 0n,
  });

  const app = createApp({ relay, store, gasGuard });
  const res = await app.request("/settle", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(buildSettleBody()),
  });
  assert.equal(res.status, 503);
  const body = (await res.json()) as Record<string, unknown>;
  assert.match(String(body.error), /balance check failed/i);
});

test("/settle proceeds normally when guard is disabled (caps = 0n)", async () => {
  const relay = buildMockRelay({ gasBalanceWei: 0n });
  const store = new InMemoryStore();
  const gasGuard = new GasGuard({
    minReserveWei: 0n,
    maxPerHourWei: 0n,
  });

  const app = createApp({ relay, store, gasGuard });
  const res = await app.request("/settle", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(buildSettleBody()),
  });
  // The mock relay returns success; the guard does not interfere.
  assert.equal(res.status, 200);
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(body.success, true);
  // Guard recorded the broadcast spend.
  assert.equal(gasGuard.currentSpendWei(), ONE_GWEI);
});
