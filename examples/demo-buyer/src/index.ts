// Swarmwage end-to-end demo — buyer side.
// License: MIT
//
// Setup (in three terminals):
//   1) pnpm --filter @swarmwage/registry dev                    # http://localhost:3000
//   2a) SELLER_PRIVATE_KEY=0x... pnpm --filter @swarmwage/example-seller-image-gen start
//       — or —
//   2b) SELLER_PRIVATE_KEY=0x... pnpm --filter @swarmwage/example-seller-chart-gen start
//   3) BUYER_PRIVATE_KEY=0x... [CAPABILITY=...] pnpm --filter @swarmwage/example-demo-buyer start
//
// Both keys can be generated with:
//   node -e 'import("viem/accounts").then(m=>console.log(m.generatePrivateKey()))'
//
// CAPABILITY env var selects the demo:
//   image.generate.photorealistic.png  (default) — pairs with seller-image-gen
//   chart.generate.from-data                     — pairs with seller-chart-gen
//   code.execute.sandboxed                       — pairs with seller-code-exec

import { writeFile } from "node:fs/promises";
import { generatePrivateKey } from "viem/accounts";
import { AgentClient, type Hex } from "@swarmwage/agent-sdk";

const REGISTRY_URL = process.env.REGISTRY_URL ?? "http://localhost:3000";
const NETWORK = (process.env.NETWORK ?? "base-sepolia") as
  | "base"
  | "base-sepolia";
const CAPABILITY =
  process.env.CAPABILITY ?? "image.generate.photorealistic.png";

const buyerKey =
  (process.env.BUYER_PRIVATE_KEY as Hex | undefined) ?? generatePrivateKey();

const client = new AgentClient({
  privateKey: buyerKey,
  registryUrl: REGISTRY_URL,
  network: NETWORK,
});

function log(label: string, value?: unknown): void {
  if (value === undefined) {
    process.stdout.write(`\n=== ${label} ===\n`);
  } else {
    process.stdout.write(
      `  ${label}: ${typeof value === "string" ? value : JSON.stringify(value)}\n`,
    );
  }
}

// -------------------------------------------------------------------------
// Capability scenarios — each builds the hire params and handles the result
// -------------------------------------------------------------------------

interface Scenario {
  capability: string;
  maxPriceUsdc: string;
  maxLatencyMs: number;
  params: Record<string, unknown>;
  /** Save the seller's `result` to disk. Returns a one-line summary for logs. */
  saveResult(result: Record<string, unknown>): Promise<string>;
}

function imageScenario(): Scenario {
  const PROMPT =
    process.env.PROMPT ?? "a friendly robot painting a sunset, photorealistic";
  const WIDTH = Number(process.env.WIDTH ?? 768);
  const HEIGHT = Number(process.env.HEIGHT ?? 768);
  return {
    capability: "image.generate.photorealistic.png",
    maxPriceUsdc: "1.00",
    maxLatencyMs: 30_000,
    params: { prompt: PROMPT, width: WIDTH, height: HEIGHT },
    async saveResult(result) {
      const r = result as { image_b64: string; width: number; height: number };
      const buf = Buffer.from(r.image_b64, "base64");
      const out = "./demo-output.png";
      await writeFile(out, buf);
      return `${out} (${buf.byteLength.toLocaleString()} bytes, ${r.width}x${r.height})`;
    },
  };
}

function chartScenario(): Scenario {
  const TITLE = process.env.CHART_TITLE ?? "Weekly revenue (sample)";
  const TYPE = (process.env.CHART_TYPE ?? "bar") as "bar" | "line" | "pie";
  const WIDTH = Number(process.env.WIDTH ?? 1024);
  const HEIGHT = Number(process.env.HEIGHT ?? 640);
  const THEME = (process.env.CHART_THEME ?? "dark") as "light" | "dark";

  // Default sample dataset; override with CHART_DATA=JSON to pass your own.
  const defaultData = [
    { x: "Mon", y: 12.4 },
    { x: "Tue", y: 18.1 },
    { x: "Wed", y: 22.7 },
    { x: "Thu", y: 19.3 },
    { x: "Fri", y: 28.5 },
    { x: "Sat", y: 33.2 },
    { x: "Sun", y: 30.1 },
  ];
  const data = process.env.CHART_DATA
    ? (JSON.parse(process.env.CHART_DATA) as typeof defaultData)
    : defaultData;

  return {
    capability: "chart.generate.from-data",
    maxPriceUsdc: "1.00",
    maxLatencyMs: 15_000,
    params: {
      title: TITLE,
      data,
      chart_type: TYPE,
      width: WIDTH,
      height: HEIGHT,
      x_label: process.env.X_LABEL ?? "Day",
      y_label: process.env.Y_LABEL ?? "USD",
      theme: THEME,
    },
    async saveResult(result) {
      const r = result as {
        image_b64: string;
        width: number;
        height: number;
        chart_type: string;
      };
      const buf = Buffer.from(r.image_b64, "base64");
      const out = "./demo-output.png";
      await writeFile(out, buf);
      return `${out} (${buf.byteLength.toLocaleString()} bytes, ${r.width}x${r.height}, ${r.chart_type})`;
    },
  };
}

function codeExecScenario(): Scenario {
  const DEFAULT_CODE = `# Default sample: small computational task with stdlib only.
import math
n = 12
fibs = [0, 1]
for _ in range(n - 2):
    fibs.append(fibs[-1] + fibs[-2])
print("fibonacci(12):", fibs)
print("sum:", sum(fibs))
print("pi (8 digits):", round(math.pi, 8))
`;
  const code = process.env.CODE ?? DEFAULT_CODE;
  const stdin = process.env.STDIN;
  const timeoutMs = Number(process.env.TIMEOUT_MS ?? 5000);

  return {
    capability: "code.execute.sandboxed",
    maxPriceUsdc: "1.00",
    maxLatencyMs: 35_000,
    params: {
      code,
      language: "python",
      ...(stdin !== undefined ? { stdin } : {}),
      timeout_ms: timeoutMs,
    },
    async saveResult(result) {
      const r = result as {
        stdout: string;
        stderr: string;
        exit_code: number;
        duration_ms: number;
        truncated: boolean;
      };
      process.stdout.write("\n--- stdout ---\n");
      process.stdout.write(r.stdout);
      if (r.stderr) {
        process.stdout.write("--- stderr ---\n");
        process.stdout.write(r.stderr);
      }
      return `exit_code=${r.exit_code}  duration_ms=${r.duration_ms}  truncated=${r.truncated}`;
    },
  };
}

function pickScenario(capability: string): Scenario {
  switch (capability) {
    case "image.generate.photorealistic.png":
      return imageScenario();
    case "chart.generate.from-data":
      return chartScenario();
    case "code.execute.sandboxed":
      return codeExecScenario();
    default:
      throw new Error(
        `Unknown CAPABILITY: ${capability}. Supported: image.generate.photorealistic.png, chart.generate.from-data, code.execute.sandboxed`,
      );
  }
}

// -------------------------------------------------------------------------
// Main
// -------------------------------------------------------------------------

(async () => {
  const scenario = pickScenario(CAPABILITY);

  log("buyer agent");
  log("agent_id", client.agentId);
  log("capability", scenario.capability);

  log(`step 1 — searching for ${scenario.capability}`);
  const results = await client.search({
    capability: scenario.capability,
    max_price_usdc: scenario.maxPriceUsdc,
    max_latency_ms: scenario.maxLatencyMs,
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
      "  no agents found. Is the matching seller running? See README.\n",
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
    capability: scenario.capability,
    params: scenario.params,
    max_price_usdc: scenario.maxPriceUsdc,
    max_latency_ms: scenario.maxLatencyMs,
  });
  const elapsed = Date.now() - t0;

  log("step 3 — result received and verified", undefined);
  log("latency_ms", elapsed);
  log("price_paid_usdc", response.receipt.price_paid_usdc);
  log("verification_passed", response.verification.all_passed);
  log("receipt_id", response.receipt.receipt_id);
  log("tx_hash", response.receipt.tx_hash);
  if (
    response.receipt.tx_hash &&
    response.receipt.tx_hash !==
      "0x0000000000000000000000000000000000000000000000000000000000000000"
  ) {
    const explorer =
      NETWORK === "base"
        ? "https://basescan.org/tx/"
        : "https://sepolia.basescan.org/tx/";
    log("explorer", `${explorer}${response.receipt.tx_hash}`);
  }

  const summary = await scenario.saveResult(response.result);
  log("output saved", summary);

  log("step 4 — submitting rating");
  await client.rate(response.rating_token, { stars: 5, latency_ms: elapsed });
  log("rating submitted", "5 stars");

  process.stdout.write("\nDone. Open demo-output.png to see the result.\n");
})().catch((err) => {
  process.stderr.write(`\nDemo failed: ${(err as Error).message}\n`);
  process.exit(1);
});
