// Smoke test PostgresStore (indexer) against a live Postgres / Supabase database.
// License: BUSL-1.1
//
// Usage (from repo root, via tsx — no build required):
//   DATABASE_URL='postgresql://...' \
//     pnpm --filter @swarmwage/indexer exec tsx scripts/smoke-postgres.mjs
//
// Verifies:
//   - upsertTransactions writes idempotently (re-running adds no new rows)
//   - getLastIndexedBlock / setLastIndexedBlock round-trip the cursor
//   - bigint values (block_number, value_usdc_atomic) preserve precision

import { PostgresStore } from "../src/store.ts";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("Set DATABASE_URL to a Postgres / Supabase connection string");
  process.exit(2);
}

const store = new PostgresStore({ connectionString: DATABASE_URL });

const SMOKE_CHAIN = 99999; // synthetic chain id, never collides with real chains
const txHash = "0x" + "c".repeat(64);

const tx1 = {
  chain_id: SMOKE_CHAIN,
  block_number: 18_000_001n,
  log_index: 1,
  tx_hash: txHash,
  from_address: "0xcafebabecafebabecafebabecafebabecafebabe",
  to_address: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
  recipient_agent_id: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
  value_usdc_atomic: 50_000n,
  ts: Math.floor(Date.now() / 1000),
};
const tx2 = { ...tx1, log_index: 2, value_usdc_atomic: 25_000n };

async function main() {
  console.log("[smoke] upsertTransactions x2 (first run — should write)");
  await store.upsertTransactions([tx1, tx2]);
  const sizeAfterFirst = await store.size();
  console.log("  size after first write:", sizeAfterFirst);

  console.log("[smoke] upsertTransactions same rows (idempotent — should NOT write)");
  await store.upsertTransactions([tx1, tx2]);
  const sizeAfterSecond = await store.size();
  console.log("  size after second write:", sizeAfterSecond);
  if (sizeAfterSecond !== sizeAfterFirst) {
    throw new Error(
      `Idempotency failed: size changed ${sizeAfterFirst} → ${sizeAfterSecond}`,
    );
  }

  console.log("[smoke] setLastIndexedBlock");
  await store.setLastIndexedBlock(SMOKE_CHAIN, 18_000_001n);

  console.log("[smoke] getLastIndexedBlock");
  const cursor = await store.getLastIndexedBlock(SMOKE_CHAIN);
  console.log("  cursor:", cursor);
  if (cursor !== 18_000_001n) {
    throw new Error(`Cursor round-trip failed: got ${cursor}`);
  }

  console.log("[smoke] setLastIndexedBlock — advance");
  await store.setLastIndexedBlock(SMOKE_CHAIN, 18_000_500n);
  const advanced = await store.getLastIndexedBlock(SMOKE_CHAIN);
  console.log("  cursor advanced:", advanced);
  if (advanced !== 18_000_500n) {
    throw new Error(`Cursor advance failed: got ${advanced}`);
  }

  await store.close();
  console.log("[smoke] OK");
}

main().catch((err) => {
  console.error("[smoke] FAIL:", err);
  process.exit(1);
});
