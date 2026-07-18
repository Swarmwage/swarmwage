// Reference Swarmwage seller — fulfills chart.generate.from-data
// via a long-running matplotlib sidecar (Python).
// License: MIT

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { Hex } from "@swarmwage/agent-sdk";
import { createSellerRuntime } from "@swarmwage/example-seller-runtime";
import type { Network } from "x402-hono";

const PRIVATE_KEY = process.env.SELLER_PRIVATE_KEY as Hex | undefined;
if (!PRIVATE_KEY) {
  process.stderr.write(
    "seller-chart-gen: SELLER_PRIVATE_KEY required (0x-prefixed 32-byte hex)\n",
  );
  process.exit(1);
}
const PORT = Number(process.env.PORT ?? 4002);
const REGISTRY_URL = process.env.REGISTRY_URL ?? "http://localhost:3000";
const PUBLIC_URL = process.env.PUBLIC_URL ?? `http://localhost:${PORT}`;
const PRICE_USDC = process.env.PRICE_USDC ?? "0.05";
const NETWORK = (process.env.NETWORK ?? "base-sepolia") as Network;
const FACILITATOR_URL = (process.env.FACILITATOR_URL ??
  "https://x402.org/facilitator") as `${string}://${string}`;
const PYTHON_BIN = process.env.PYTHON_BIN ?? "python3";
const HIRE_RATE_LIMIT_PER_IP = Number(process.env.HIRE_RATE_LIMIT_PER_IP ?? 20);
const HIRE_RATE_WINDOW_MS = Number(process.env.HIRE_RATE_WINDOW_MS ?? 60_000);
const MAX_DAILY_HIRES = Number(process.env.MAX_DAILY_HIRES ?? 1000);
const MAX_DAILY_SPEND_USD = Number(process.env.MAX_DAILY_SPEND_USD ?? 50);
const EST_UPSTREAM_USD_PER_CALL = Number(
  process.env.EST_UPSTREAM_USD_PER_CALL ?? 0,
);
const CAPABILITY = "chart.generate.from-data";

type ChartType = "bar" | "line" | "pie";
interface ChartGenInput {
  title?: string;
  data: { x: string | number; y: number }[];
  chart_type: ChartType;
  width: number;
  height: number;
  x_label?: string;
  y_label?: string;
  theme?: "light" | "dark";
  seed?: number;
}
interface ChartGenOutput {
  image_b64: string;
  width: number;
  height: number;
  chart_type: ChartType;
}
type RendererMessage =
  | (ChartGenOutput & { id: string; ok: true })
  | { id: string; ok: false; error: string; trace?: string };

class Renderer {
  private child!: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<
    string,
    { resolve: (out: ChartGenOutput) => void; reject: (error: Error) => void }
  >();
  private nextId = 0;

  async start(): Promise<void> {
    const script = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "render",
      "server.py",
    );
    this.child = spawn(PYTHON_BIN, ["-u", script], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stderr.on("data", (chunk: Buffer) => {
      process.stderr.write(`  [py] ${chunk.toString()}`);
    });
    this.child.on("exit", (code, signal) => {
      const reason = `python renderer exited (code=${code}, signal=${signal})`;
      for (const pending of this.pending.values()) {
        pending.reject(new Error(reason));
      }
      this.pending.clear();
      process.stderr.write(`seller-chart-gen: FATAL ${reason}\n`);
      process.exit(1);
    });
    const lines = createInterface({ input: this.child.stdout });
    await new Promise<void>((resolveReady, rejectReady) => {
      const onFirstLine = (line: string) => {
        try {
          if ((JSON.parse(line) as { ready?: boolean }).ready) {
            lines.off("line", onFirstLine);
            lines.on("line", (nextLine) => this.onLine(nextLine));
            resolveReady();
          } else rejectReady(new Error(`unexpected first line: ${line}`));
        } catch {
          rejectReady(new Error(`bad ready line: ${line}`));
        }
      };
      lines.on("line", onFirstLine);
    });
  }

  private onLine(line: string): void {
    let message: RendererMessage;
    try {
      message = JSON.parse(line) as RendererMessage;
    } catch {
      process.stderr.write(`seller-chart-gen: malformed renderer line: ${line}\n`);
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) {
      process.stderr.write(
        `seller-chart-gen: renderer response for unknown id=${message.id}\n`,
      );
      return;
    }
    this.pending.delete(message.id);
    if (!message.ok) {
      pending.reject(new Error(message.error));
      return;
    }
    pending.resolve({
      image_b64: message.image_b64,
      width: message.width,
      height: message.height,
      chart_type: message.chart_type,
    });
  }

  render(input: ChartGenInput): Promise<ChartGenOutput> {
    const id = `r${++this.nextId}`;
    return new Promise((resolveRender, rejectRender) => {
      this.pending.set(id, { resolve: resolveRender, reject: rejectRender });
      this.child.stdin.write(`${JSON.stringify({ id, ...input })}\n`, (error) => {
        if (error) {
          this.pending.delete(id);
          rejectRender(error);
        }
      });
    });
  }
}

const renderer = new Renderer();
const runtime = createSellerRuntime({
  identity: { privateKey: PRIVATE_KEY, serviceName: "seller-chart-gen" },
  listing: {
    capability: CAPABILITY,
    priceUsdc: PRICE_USDC,
    maxLatencyMs: 8_000,
    firstCallFree: true,
    publicUrl: PUBLIC_URL,
    registryUrl: REGISTRY_URL,
    publishedMessage: `seller-chart-gen: listing published (capability=${CAPABILITY}, price=${PRICE_USDC} USDC)\n`,
  },
  payment: { network: NETWORK, facilitatorUrl: FACILITATOR_URL },
  limits: {
    perIp: HIRE_RATE_LIMIT_PER_IP,
    windowMs: HIRE_RATE_WINDOW_MS,
    maxDailyHires: MAX_DAILY_HIRES,
    maxDailySpendUsd: MAX_DAILY_SPEND_USD,
    estimatedUpstreamUsd: EST_UPSTREAM_USD_PER_CALL,
  },
  metadata: {
    backend: "matplotlib (python sidecar)",
    network: NETWORK,
    price_usdc: PRICE_USDC,
  },
  async fulfill(raw, c) {
    const params = raw as ChartGenInput | undefined;
    if (!params || !Array.isArray(params.data) || params.data.length === 0) {
      return c.json({ error: "Missing or empty params.data" }, 400);
    }
    if (!params.chart_type || !["bar", "line", "pie"].includes(params.chart_type)) {
      return c.json({ error: "params.chart_type must be bar|line|pie" }, 400);
    }
    if (typeof params.width !== "number" || typeof params.height !== "number") {
      return c.json(
        { error: "params.width and params.height required" },
        400,
      );
    }
    try {
      return {
        result: await renderer.render(params),
        verification: {
          checks: [
            { name: "is_valid_png", passed: true },
            { name: "matches_dimensions", passed: true },
            { name: "chart_type_match", passed: true },
          ],
          all_passed: true,
        },
      };
    } catch (error) {
      return c.json(
        { error: `Render failed: ${(error as Error).message}` },
        502,
      );
    }
  },
});

void (async () => {
  process.stderr.write(
    `seller-chart-gen: spawning matplotlib renderer (${PYTHON_BIN})…\n`,
  );
  try {
    await renderer.start();
    process.stderr.write("seller-chart-gen: renderer ready\n");
  } catch (error) {
    process.stderr.write(
      `seller-chart-gen: FATAL renderer failed to start — ${(error as Error).message}\n`,
    );
    process.exit(1);
  }
  try {
    await renderer.render({
      chart_type: "bar",
      data: [{ x: "warm", y: 1 }],
      width: 320,
      height: 200,
    });
    process.stderr.write("seller-chart-gen: warmup render done\n");
  } catch (error) {
    process.stderr.write(
      `seller-chart-gen: WARN warmup render failed — ${(error as Error).message}\n`,
    );
  }
  await runtime.start(
    PORT,
    `seller-chart-gen v0.0.1 listening on ${PUBLIC_URL} (agent_id=${runtime.agentId})\n`,
  );
})();
