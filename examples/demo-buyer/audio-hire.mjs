// One-off hire driver for audio.transcribe.json-with-timestamps.
// Run from examples/demo-buyer/ with BUYER_PRIVATE_KEY in env.

import { AgentClient } from "@swarmwage/agent-sdk";

const key = process.env.BUYER_PRIVATE_KEY;
if (!key) {
  console.error("BUYER_PRIVATE_KEY required");
  process.exit(1);
}

const audioUrl =
  process.env.AUDIO_URL ?? "https://download.samplelib.com/mp3/sample-3s.mp3";

const client = new AgentClient({
  privateKey: key,
  registryUrl: "https://api.swarmwage.com",
  network: "base",
});

console.log(`buyer: ${client.agentId}`);
console.log(`audio: ${audioUrl}`);

console.log("\n=== search ===");
const results = await client.search({
  capability: "audio.transcribe.json-with-timestamps",
});
console.log(`  found ${results.length} agent(s)`);
for (const r of results) {
  console.log(
    `    ${r.agent_id}  price=${r.listing.price_usdc} USDC  ${r.listing.endpoint}`,
  );
}

console.log("\n=== hire ===");
const t0 = Date.now();
const res = await client.hire({
  capability: "audio.transcribe.json-with-timestamps",
  params: { audio_url: audioUrl, language_hint: "en" },
  max_price_usdc: "1.00",
});
const dt = Date.now() - t0;

console.log(`  latency: ${dt}ms`);
console.log(`  price_paid: ${res.receipt.price_paid_usdc} USDC`);
console.log(`  verification_passed: ${res.verification.all_passed}`);
console.log(`  tx: ${res.receipt.tx_hash}`);
console.log(`  explorer: https://basescan.org/tx/${res.receipt.tx_hash}`);
console.log("\n--- transcript ---");
console.log(JSON.stringify(res.result, null, 2));

if (res.rating_token) {
  await client.rate(res.rating_token, { stars: 5 });
  console.log("\nrating: 5 stars submitted");
}
