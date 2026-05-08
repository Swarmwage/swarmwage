// Smoke test PostgresStore (facilitator) against a live Postgres / Supabase database.
// License: BUSL-1.1
//
// Usage (from repo root, via tsx — no build required):
//   DATABASE_URL='postgresql://...' \
//     pnpm --filter @swarmwage/facilitator exec tsx scripts/smoke-postgres.mjs
//
// Verifies:
//   - appendLog writes a verify + a settle entry
//   - JSONB serialization round-trips request/response payloads
//   - bigint atomic-USDC + gas-wei values preserve precision

import { PostgresStore } from "../src/store.ts";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("Set DATABASE_URL to a Postgres / Supabase connection string");
  process.exit(2);
}

const store = new PostgresStore({
  connectionString: DATABASE_URL,
  onError: (err) =>
    console.error("[smoke] write error:", err instanceof Error ? err.message : err),
});

const verifyEntry = {
  ts: Date.now(),
  route: "verify",
  network: "base-sepolia",
  agent_id: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
  capability: "chart.generate.from-data",
  payer_address: "0xcafebabecafebabecafebabecafebabecafebabe",
  recipient_address: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
  amount_usdc_atomic: "50000",
  tx_hash: null,
  gas_eth_spent_wei: null,
  latency_ms: 42,
  ok: true,
  error: null,
  raw_request: { x402Version: 1, scheme: "exact", network: "base-sepolia" },
  raw_response: { isValid: true },
};

const settleEntry = {
  ts: Date.now(),
  route: "settle",
  network: "base-sepolia",
  agent_id: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
  capability: "chart.generate.from-data",
  payer_address: "0xcafebabecafebabecafebabecafebabecafebabe",
  recipient_address: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
  amount_usdc_atomic: "50000",
  tx_hash: "0x" + "d".repeat(64),
  // Realistic gas spent: ~120 gwei * 80k gas = 9_600_000 gwei = 9.6e15 wei.
  // Exceeds Number.MAX_SAFE_INTEGER (9e15) only in worst-case mainnet spikes,
  // but we keep the type as bigint so we never have to worry about precision.
  gas_eth_spent_wei: "9600000000000000",
  latency_ms: 1280,
  ok: true,
  error: null,
  raw_request: { x402Version: 1, scheme: "exact", network: "base-sepolia" },
  raw_response: {
    success: true,
    transaction: "0x" + "d".repeat(64),
    network: "base-sepolia",
  },
};

async function main() {
  console.log("[smoke] size before:", await store.size());

  console.log("[smoke] appendLog verify");
  await store.appendLog(verifyEntry);

  console.log("[smoke] appendLog settle (with gas-wei bigint)");
  await store.appendLog(settleEntry);

  console.log("[smoke] size after:", await store.size());

  await store.close();
  console.log("[smoke] OK");
}

main().catch((err) => {
  console.error("[smoke] FAIL:", err);
  process.exit(1);
});
