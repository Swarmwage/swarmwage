// Swarmwage Indexer — smoke test
// License: BUSL-1.1
//
// Exercises the indexer loop and HTTP routes against a stubbed viem
// public client. No real RPC, no real registry — the goal is to confirm
// that:
//   1. The cursor initialises correctly from `startBlock`.
//   2. `getLogs` is called with the expected `(fromBlock, toBlock)` range.
//   3. Each decoded log produces a row in the store.
//   4. The cursor advances after a successful range write.
//   5. The HTTP `/health` route reports the cursor.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { createApp } from "../index.js";
import { createExternalResolver } from "../external.js";
import { createIndexer } from "../indexer.js";
import type { RegistryResolver } from "../registry.js";
import { InMemoryStore } from "../store.js";

const CHAIN_ID = 84_532; // base-sepolia

interface FakeLog {
  blockNumber: bigint;
  logIndex: number;
  transactionHash: string;
  args: { from: string; to: string; value: bigint };
}

function buildFakeClient(opts: {
  head: bigint;
  logsByRange: Array<{ from: bigint; to: bigint; logs: FakeLog[] }>;
}) {
  const calls: Array<{ fromBlock: bigint; toBlock: bigint }> = [];
  return {
    calls,
    publicClient: {
      async getBlockNumber() {
        return opts.head;
      },
      async getLogs(args: { fromBlock: bigint; toBlock: bigint }) {
        calls.push({ fromBlock: args.fromBlock, toBlock: args.toBlock });
        const match = opts.logsByRange.find(
          (r) => r.from === args.fromBlock && r.to === args.toBlock,
        );
        return match ? match.logs : [];
      },
      async getBlock({ blockNumber }: { blockNumber: bigint }) {
        return { timestamp: 1_700_000_000n + blockNumber };
      },
    },
  };
}

function buildResolver(map: Record<string, string | null>): RegistryResolver {
  return {
    async resolveAgentId(address: string): Promise<string | null> {
      return map[address.toLowerCase()] ?? null;
    },
  };
}

test("ensureCursor honours an explicit startBlock", async () => {
  const fake = buildFakeClient({ head: 1_000n, logsByRange: [] });
  const store = new InMemoryStore();
  const indexer = createIndexer({
    publicClient: fake.publicClient,
    store,
    registry: buildResolver({}),
    network: "base-sepolia",
    chainId: CHAIN_ID,
    startBlock: 500n,
    maxBlockRange: 2000,
    intervalMs: 60_000,
  });

  // No logs in the range -> cursor still advances to head.
  await indexer.tickOnce();
  assert.equal(indexer.lastIndexedBlock(), 1_000n);
  // `from` should have been startBlock (500), `to` clipped to head (1000).
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0]?.fromBlock, 500n);
  assert.equal(fake.calls[0]?.toBlock, 1_000n);
});

test("tickOnce decodes logs and writes them to the store", async () => {
  const recipient = "0x1111111111111111111111111111111111111111";
  const sender = "0x2222222222222222222222222222222222222222";
  const fake = buildFakeClient({
    head: 200n,
    logsByRange: [
      {
        from: 101n,
        to: 200n,
        logs: [
          {
            blockNumber: 150n,
            logIndex: 0,
            transactionHash: "0xdead",
            args: { from: sender, to: recipient, value: 1_000_000n },
          },
          {
            blockNumber: 175n,
            logIndex: 3,
            transactionHash: "0xbeef",
            args: { from: sender, to: recipient, value: 2_500_000n },
          },
        ],
      },
    ],
  });
  const store = new InMemoryStore();
  await store.setLastIndexedBlock(CHAIN_ID, 100n);

  const indexer = createIndexer({
    publicClient: fake.publicClient,
    store,
    registry: buildResolver({ [recipient.toLowerCase()]: "agent_alpha" }),
    network: "base-sepolia",
    chainId: CHAIN_ID,
    maxBlockRange: 2000,
    intervalMs: 60_000,
  });

  const written = await indexer.tickOnce();
  assert.equal(written, 2);
  assert.equal(indexer.lastIndexedBlock(), 200n);
  assert.equal(await store.size(), 2);

  const snap = store.snapshot();
  assert.equal(snap.length, 2);
  assert.equal(snap[0]?.recipient_agent_id, "agent_alpha");
  assert.equal(snap[0]?.value_usdc_atomic, 1_000_000n);
  assert.equal(snap[0]?.tx_hash, "0xdead");
  assert.equal(snap[1]?.recipient_agent_id, "agent_alpha");
});

test("tickOnce tags external recipients without an agent_id", async () => {
  const extAddr = "0x5555555555555555555555555555555555555555";
  const sender = "0x6666666666666666666666666666666666666666";
  const fake = buildFakeClient({
    head: 100n,
    logsByRange: [
      {
        from: 1n,
        to: 100n,
        logs: [
          {
            blockNumber: 42n,
            logIndex: 0,
            transactionHash: "0xfeed",
            args: { from: sender, to: extAddr, value: 10_000n },
          },
        ],
      },
    ],
  });
  const store = new InMemoryStore();
  await store.setLastIndexedBlock(CHAIN_ID, 0n);

  // Seed an external resolver from an injected reader (no filesystem).
  const external = createExternalResolver({
    path: "seed.json",
    readFileImpl: () =>
      JSON.stringify([
        { address: extAddr, source: "example-catalog", label: "Example Service", category: "Search" },
      ]),
  });
  assert.equal(external.size(), 1);

  const indexer = createIndexer({
    publicClient: fake.publicClient,
    store,
    registry: buildResolver({}),
    external,
    network: "base-sepolia",
    chainId: CHAIN_ID,
    maxBlockRange: 2000,
    intervalMs: 60_000,
  });

  await indexer.tickOnce();
  const snap = store.snapshot();
  assert.equal(snap.length, 1);
  assert.equal(snap[0]?.recipient_agent_id, null);
  assert.equal(snap[0]?.recipient_source, "example-catalog");
  assert.equal(snap[0]?.recipient_label, "Example Service");
});

test("tickOnce is idempotent across replays", async () => {
  const recipient = "0x3333333333333333333333333333333333333333";
  const sender = "0x4444444444444444444444444444444444444444";
  const sameLog: FakeLog = {
    blockNumber: 50n,
    logIndex: 1,
    transactionHash: "0xc0ffee",
    args: { from: sender, to: recipient, value: 999_999n },
  };
  const fake = buildFakeClient({
    head: 100n,
    logsByRange: [{ from: 1n, to: 100n, logs: [sameLog] }],
  });
  const store = new InMemoryStore();
  await store.setLastIndexedBlock(CHAIN_ID, 0n);

  const indexer = createIndexer({
    publicClient: fake.publicClient,
    store,
    registry: buildResolver({}),
    network: "base-sepolia",
    chainId: CHAIN_ID,
    maxBlockRange: 2000,
    intervalMs: 60_000,
  });

  await indexer.tickOnce();
  // Replay the same range. The cursor stays at head; no new range is
  // requested because `from > latest`.
  await indexer.tickOnce();
  assert.equal(await store.size(), 1);
});

test("tickOnce splits a backlog into batches of MAX_BLOCK_RANGE", async () => {
  const fake = buildFakeClient({
    head: 4_500n,
    logsByRange: [],
  });
  const store = new InMemoryStore();
  await store.setLastIndexedBlock(CHAIN_ID, 0n);

  const indexer = createIndexer({
    publicClient: fake.publicClient,
    store,
    registry: buildResolver({}),
    network: "base-sepolia",
    chainId: CHAIN_ID,
    maxBlockRange: 2000,
    intervalMs: 60_000,
  });

  await indexer.tickOnce();
  // 4500 blocks at 2000/batch => 3 calls: [1..2000], [2001..4000], [4001..4500]
  assert.equal(fake.calls.length, 3);
  assert.equal(fake.calls[0]?.fromBlock, 1n);
  assert.equal(fake.calls[0]?.toBlock, 2_000n);
  assert.equal(fake.calls[1]?.fromBlock, 2_001n);
  assert.equal(fake.calls[1]?.toBlock, 4_000n);
  assert.equal(fake.calls[2]?.fromBlock, 4_001n);
  assert.equal(fake.calls[2]?.toBlock, 4_500n);
  assert.equal(indexer.lastIndexedBlock(), 4_500n);
});

test("HTTP /health reports the cursor and store kind", async () => {
  const fake = buildFakeClient({ head: 10n, logsByRange: [] });
  const store = new InMemoryStore();
  const indexer = createIndexer({
    publicClient: fake.publicClient,
    store,
    registry: buildResolver({}),
    network: "base-sepolia",
    chainId: CHAIN_ID,
    startBlock: 5n,
    maxBlockRange: 2000,
    intervalMs: 60_000,
  });
  await indexer.tickOnce();

  const app = createApp({
    chain: {
      network: "base-sepolia",
      chainId: CHAIN_ID,
      publicClient: fake.publicClient,
    },
    store,
    indexer,
    storeKind: "memory",
  });
  const res = await app.request("/health");
  assert.equal(res.status, 200);
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(body.network, "base-sepolia");
  assert.equal(body.chain_id, CHAIN_ID);
  assert.equal(body.last_indexed_block, "10");
  assert.equal(body.store_kind, "memory");
  assert.equal(body.ok, true);
});
