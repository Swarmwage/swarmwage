// Smoke test PostgresStore against a live Postgres / Supabase database.
// License: BUSL-1.1
//
// Usage (from repo root, via tsx — no build required):
//   DATABASE_URL='postgresql://...' \
//     pnpm --filter @swarmwage/registry exec tsx scripts/smoke-postgres.mjs
//
// What it does (idempotent — safe to re-run):
//   1. upsertAgent(0xdead..beef)
//   2. upsertListing for the agent + chart capability
//   3. recordHire two hires (verification_passed=true twice)
//   4. consumeRatingTokenAndStore one 5-star rating
//   5. appendReceipt — first call inserts, second call short-circuits (409 path)
//   6. recordTelemetry one event
//   7. getReputation prints aggregates
//   8. search returns the listing
//   9. close pool

import { PostgresStore } from "../src/store/postgres.ts";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("Set DATABASE_URL to a Postgres / Supabase connection string");
  process.exit(2);
}

const store = new PostgresStore({ connectionString: DATABASE_URL });

const agentId = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
const buyerId = "0xcafebabecafebabecafebabecafebabecafebabe";
const capability = "chart.generate.from-data";
const hireA = "smoke-hire-a";
const hireB = "smoke-hire-b";
const txA = "0x" + "a".repeat(64);
const txB = "0x" + "b".repeat(64);

async function main() {
  console.log("[smoke] upsertAgent");
  await store.upsertAgent(agentId);

  console.log("[smoke] upsertListing");
  await store.upsertListing({
    agent_id: agentId,
    capability,
    price_usdc: "0.05",
    currency: "USDC",
    chain: "base",
    max_latency_ms: 5000,
    first_call_free: false,
    endpoint: "https://example.invalid/chart",
    signature: "0x" + "0".repeat(130),
  });

  console.log("[smoke] recordHire x2");
  await store.recordHire({
    receipt_id: hireA,
    buyer_id: buyerId,
    seller_id: agentId,
    capability,
    tx_hash: txA,
    price_paid_usdc: "0.05",
    verification_passed: true,
    latency_ms: 420,
    completed_at: Date.now() - 60_000,
  });
  await store.recordHire({
    receipt_id: hireB,
    buyer_id: buyerId,
    seller_id: agentId,
    capability,
    tx_hash: txB,
    price_paid_usdc: "0.05",
    verification_passed: true,
    latency_ms: 380,
    completed_at: Date.now() - 30_000,
  });

  console.log("[smoke] consumeRatingTokenAndStore");
  try {
    await store.consumeRatingTokenAndStore({
      rating_token: hireA,
      receipt_id: hireA,
      rater_id: buyerId,
      rated_id: agentId,
      stars: 5,
      latency_ms: 420,
      comment: "smoke",
      created_at: Date.now(),
    });
  } catch (err) {
    if (err instanceof Error && err.message === "Rating token already used") {
      console.log("  (already used — re-run is idempotent for this branch)");
    } else {
      throw err;
    }
  }

  console.log("[smoke] appendReceipt first call");
  const receiptA = await store.appendReceipt({
    protocol_version: "swarmwage/v0.3",
    hire_id: "smoke-receipt-a",
    agent_id: agentId,
    buyer: buyerId,
    capability,
    amount_usdc_atomic: "50000",
    network: "base-sepolia",
    tx_hash: txA,
    completed_at: new Date().toISOString(),
    verification_all_passed: true,
    verification_checks: { schema: true, latency_under_max: true },
    signature: "0x" + "1".repeat(130),
  });
  console.log("  result:", receiptA);

  console.log("[smoke] appendReceipt second call (should NOT insert)");
  const receiptB = await store.appendReceipt({
    protocol_version: "swarmwage/v0.3",
    hire_id: "smoke-receipt-a",
    agent_id: agentId,
    buyer: buyerId,
    capability,
    amount_usdc_atomic: "50000",
    network: "base-sepolia",
    tx_hash: txA,
    completed_at: new Date().toISOString(),
    verification_all_passed: true,
    verification_checks: { schema: true, latency_under_max: true },
    signature: "0x" + "1".repeat(130),
  });
  console.log("  result:", receiptB);

  console.log("[smoke] recordTelemetry");
  await store.recordTelemetry({
    ts: Date.now(),
    sdk_version: "smoke",
    agent_id: agentId,
    event: { kind: "smoke_test" },
  });

  console.log("[smoke] getReputation");
  const rep = await store.getReputation(agentId);
  console.log(rep);

  console.log("[smoke] search");
  const results = await store.search({ capability, limit: 5 });
  console.log(`  ${results.length} result(s)`);
  for (const r of results) {
    console.log(`   - ${r.agent_id} @ ${r.listing.price_usdc} USDC, stars=${r.reputation.avg_stars}`);
  }

  await store.close();
  console.log("[smoke] OK");
}

main().catch((err) => {
  console.error("[smoke] FAIL:", err);
  process.exit(1);
});
