// Swarmwage Facilitator — concurrent /settle race-condition test
// License: BUSL-1.1
//
// Proves the FIX 1 invariant from the 2026-05-09 internal red-team review:
// when N concurrent /settle calls arrive with the SAME signed EIP-3009
// authorization, exactly ONE reaches walletClient.writeContract; the
// remaining N-1 short-circuit at the in-flight nonce gate and return
// invalid_transaction_state without burning gas.
//
// Without the fix, all N would pass `authorizationState` (it's still
// false on-chain at verify time), all N would broadcast, the first would
// land and the rest would revert — burning ~21k gas per revert (~0.0002
// ETH on Base) for nothing.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import type { Address, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { __test__ } from "../relay.js";
import { TRANSFER_WITH_AUTHORIZATION_TYPES, USDC_ADDRESS } from "../usdc.js";

const { settleAuthorization } = __test__;

const NETWORK = "base-sepolia" as const;
const CHAIN_ID = 84_532;

const BUYER_KEY: Hex =
  "0x1111111111111111111111111111111111111111111111111111111111111111";
const SELLER: Address = "0x2222222222222222222222222222222222222222";

interface MockClients {
  publicClient: unknown;
  walletClient: unknown;
  /** Number of times walletClient.writeContract was actually invoked. */
  writeContractCalls: () => number;
  /** Resolve the held writeContract promises (advances the test clock). */
  finishBroadcasts: () => void;
}

function buildMockClients(): MockClients {
  let writeContractCallCount = 0;
  const broadcastResolvers: Array<() => void> = [];

  const publicClient = {
    async readContract(args: { functionName: string }) {
      if (args.functionName === "authorizationState") return false;
      if (args.functionName === "balanceOf") return 1_000_000_000n; // 1000 USDC
      throw new Error(`unexpected readContract: ${args.functionName}`);
    },
    async waitForTransactionReceipt() {
      return {
        status: "success",
        gasUsed: 21_000n,
        effectiveGasPrice: 1_000_000_000n, // 1 gwei
      };
    },
  };

  const walletClient = {
    async writeContract() {
      writeContractCallCount++;
      // Block until the test releases. This guarantees that while the first
      // settle is mid-broadcast, all the concurrent siblings have a chance
      // to enter settleAuthorization and hit the in-flight gate.
      await new Promise<void>((resolve) => broadcastResolvers.push(resolve));
      return ("0x" + "f".repeat(64)) as Hex;
    },
  };

  return {
    publicClient,
    walletClient,
    writeContractCalls: () => writeContractCallCount,
    finishBroadcasts: () => {
      while (broadcastResolvers.length > 0) {
        broadcastResolvers.shift()!();
      }
    },
  };
}

async function buildSignedAuthorization() {
  const buyer = privateKeyToAccount(BUYER_KEY);
  const value = 1_000_000n; // 1 USDC (6 decimals)
  const validAfter = 0n;
  const validBefore = BigInt(Math.floor(Date.now() / 1000) + 600);
  const nonce = `0x${"a".repeat(64)}` as Hex;

  const domain = {
    name: "USD Coin",
    version: "2",
    chainId: CHAIN_ID,
    verifyingContract: USDC_ADDRESS[NETWORK],
  } as const;

  const message = {
    from: buyer.address,
    to: SELLER,
    value,
    validAfter,
    validBefore,
    nonce,
  };

  const signature = await buyer.signTypedData({
    domain,
    types: TRANSFER_WITH_AUTHORIZATION_TYPES,
    primaryType: "TransferWithAuthorization",
    message,
  });

  // Construct the payment payload + requirements in the exact shape the
  // facilitator's settleAuthorization expects (matches the runtime shape
  // produced by FacilitatorRequestBodySchema.safeParse).
  const payload = {
    x402Version: 1,
    scheme: "exact",
    network: NETWORK,
    payload: {
      signature,
      authorization: {
        from: buyer.address,
        to: SELLER,
        value: value.toString(),
        validAfter: validAfter.toString(),
        validBefore: validBefore.toString(),
        nonce,
      },
    },
  };

  const requirements = {
    scheme: "exact",
    network: NETWORK,
    maxAmountRequired: value.toString(),
    payTo: SELLER,
    asset: USDC_ADDRESS[NETWORK],
    resource: "https://example.test/cap",
    description: "concurrency test",
    mimeType: "application/json",
    maxTimeoutSeconds: 60,
  };

  return { buyer, payload, requirements };
}

test("settle: 50 concurrent calls for same (from, nonce) — exactly one broadcasts", async () => {
  const { buyer, payload, requirements } = await buildSignedAuthorization();
  const clients = buildMockClients();
  const inFlightNonces = new Set<string>();

  const concurrent = 50;
  const settlePromises = Array.from({ length: concurrent }, () =>
    settleAuthorization({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      payload: payload as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      requirements: requirements as any,
      network: NETWORK,
      chainId: CHAIN_ID,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      publicClient: clients.publicClient as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      walletClient: clients.walletClient as any,
      account: buyer,
      inFlightNonces,
    }),
  );

  // Yield to the event loop a few times to let all 50 promises advance to
  // their writeContract await point (or hit the in-flight gate). Then
  // release the held broadcasts so the first one can complete.
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  clients.finishBroadcasts();

  const results = await Promise.all(settlePromises);

  const successes = results.filter((r) => r.response.success);
  const inFlightRejections = results.filter(
    (r) =>
      !r.response.success &&
      r.response.errorReason === "invalid_transaction_state",
  );

  assert.equal(
    clients.writeContractCalls(),
    1,
    "walletClient.writeContract must be invoked exactly once",
  );
  assert.equal(successes.length, 1, "exactly one settle response succeeds");
  assert.equal(
    inFlightRejections.length,
    concurrent - 1,
    "all other settles return invalid_transaction_state",
  );
  assert.equal(inFlightNonces.size, 0, "in-flight set drained after completion");
});

test("settle: in-flight slot is released after completion (sequential settles work)", async () => {
  const { buyer, payload, requirements } = await buildSignedAuthorization();
  const clients = buildMockClients();
  const inFlightNonces = new Set<string>();

  const settle = () =>
    settleAuthorization({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      payload: payload as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      requirements: requirements as any,
      network: NETWORK,
      chainId: CHAIN_ID,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      publicClient: clients.publicClient as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      walletClient: clients.walletClient as any,
      account: buyer,
      inFlightNonces,
    });

  // First settle — release immediately so it completes.
  const first = settle();
  await new Promise((r) => setImmediate(r));
  clients.finishBroadcasts();
  const firstResult = await first;
  assert.equal(firstResult.response.success, true);
  assert.equal(inFlightNonces.size, 0);

  // Second settle with the same authorization. In production the on-chain
  // authorizationState would now be true, blocking the duplicate. In this
  // mock we keep authorizationState=false to isolate the in-flight check
  // — this proves the slot is genuinely released, not merely entered once.
  const second = settle();
  await new Promise((r) => setImmediate(r));
  clients.finishBroadcasts();
  const secondResult = await second;
  assert.equal(secondResult.response.success, true);
  assert.equal(
    clients.writeContractCalls(),
    2,
    "second settle reaches writeContract because the slot was released",
  );
});
