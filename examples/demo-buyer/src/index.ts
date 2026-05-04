// Swarmwage end-to-end demo — buyer side.
// License: MIT
//
// Setup (in three terminals):
//   1) pnpm --filter @swarmwage/registry dev                    # http://localhost:3000
//   2) SELLER_PRIVATE_KEY=0x... pnpm --filter @swarmwage/example-seller-image-gen start
//   3) BUYER_PRIVATE_KEY=0x... PROMPT="..." pnpm --filter @swarmwage/example-demo-buyer start
//
// Both keys can be generated with:
//   node -e 'import("viem/accounts").then(m=>console.log(m.generatePrivateKey()))'

import { writeFile } from "node:fs/promises";
import { generatePrivateKey } from "viem/accounts";
import { AgentClient, type Hex } from "@swarmwage/agent-sdk";

const REGISTRY_URL = process.env.REGISTRY_URL ?? "http://localhost:3000";
const PROMPT = process.env.PROMPT ?? "a friendly robot painting a sunset, photorealistic";
const WIDTH = Number(process.env.WIDTH ?? 768);
const HEIGHT = Number(process.env.HEIGHT ?? 768);

const buyerKey =
  (process.env.BUYER_PRIVATE_KEY as Hex | undefined) ?? generatePrivateKey();

const client = new AgentClient({
  privateKey: buyerKey,
  registryUrl: REGISTRY_URL,
});

function log(label: string, value?: unknown): void {
  if (value === undefined) {
    process.stdout.write(`\n=== ${label} ===\n`);
  } else {
    process.stdout.write(`  ${label}: ${typeof value === "string" ? value : JSON.stringify(value)}\n`);
  }
}

(async () => {
  log("buyer agent");
  log("agent_id", client.agentId);

  log("step 1 — searching for image.generate.photorealistic.png");
  const results = await client.search({
    capability: "image.generate.photorealistic.png",
    max_price_usdc: "1.00",
    max_latency_ms: 30_000,
    limit: 5,
  });
  log("found", `${results.length} agent(s)`);
  for (const [i, r] of results.entries()) {
    process.stdout.write(
      `    [${i}] ${r.agent_id}  price=${r.listing.price_usdc} USDC  latency<=${r.listing.max_latency_ms}ms  endpoint=${r.listing.endpoint}\n`,
    );
  }
  if (results.length === 0) {
    process.stderr.write(
      "  no agents found. Is the seller running? See README.\n",
    );
    process.exit(1);
  }

  const top = results[0]!;

  log("step 2 — hiring the top match");
  log("seller_id", top.agent_id);
  log("price_usdc", top.listing.price_usdc);

  const t0 = Date.now();
  const response = await client.hire({
    agent_id: top.agent_id,
    endpoint: top.listing.endpoint,
    capability: "image.generate.photorealistic.png",
    params: { prompt: PROMPT, width: WIDTH, height: HEIGHT },
    max_price_usdc: "1.00",
    max_latency_ms: 30_000,
  });
  const elapsed = Date.now() - t0;

  log("step 3 — result received and verified", undefined);
  log("latency_ms", elapsed);
  log("price_paid_usdc", response.receipt.price_paid_usdc);
  log("verification_passed", response.verification.all_passed);
  log("receipt_id", response.receipt.receipt_id);

  const result = response.result as { image_b64: string; width: number; height: number };
  const buf = Buffer.from(result.image_b64, "base64");
  const outPath = `./demo-output.png`;
  await writeFile(outPath, buf);
  log("image saved", `${outPath} (${buf.byteLength.toLocaleString()} bytes, ${result.width}x${result.height})`);

  log("step 4 — submitting rating");
  await client.rate(response.rating_token, { stars: 5, latency_ms: elapsed });
  log("rating submitted", "5 stars");

  process.stdout.write("\nDone. Open demo-output.png to see the result.\n");
})().catch((err) => {
  process.stderr.write(`\nDemo failed: ${(err as Error).message}\n`);
  process.exit(1);
});
