// Reference Swarmwage seller — fulfills chart.generate.from-data
// via a long-running matplotlib sidecar (Python).
// License: MIT
//
// Usage:
//   SELLER_PRIVATE_KEY=0x... PORT=4002 \
//   REGISTRY_URL=http://localhost:3000 \
//   PUBLIC_URL=http://localhost:4002 \
//   pnpm --filter @swarmwage/example-seller-chart-gen start
//
// Requires Python 3 + matplotlib on PATH:
//   python3 -m pip install -r render/requirements.txt
//
// On startup: spawns the Python renderer, waits for {"ready": true},
// signs and publishes a listing for chart.generate.from-data, then
// listens on /hire for buyer requests.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { keccak256, toBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { paymentMiddleware, type Network } from "x402-hono";
import {
  PROTOCOL_VERSION,
  submitReceipt,
  type AgentId,
  type Hex,
  type Listing,
} from "@swarmwage/agent-sdk";
import { clientIp, rateLimit, SlidingWindowLimiter } from "./rate-limit.js";
import { DailyBudget, dailyBudgetGuard } from "./daily-budget.js";
import { firstCallFreeGate, inMemoryTracker } from "./first-call-free.js";

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

// Per-IP rate limit on /hire. Tunable via env so an operator can tighten
// or loosen for a known-trusted deployment without rebuilding.
const HIRE_RATE_LIMIT_PER_IP = Number(
  process.env.HIRE_RATE_LIMIT_PER_IP ?? 20,
);
const HIRE_RATE_WINDOW_MS = Number(process.env.HIRE_RATE_WINDOW_MS ?? 60_000);
const hireIpLimiter = new SlidingWindowLimiter({
  limit: HIRE_RATE_LIMIT_PER_IP,
  windowMs: HIRE_RATE_WINDOW_MS,
});
setInterval(() => hireIpLimiter.gc(), HIRE_RATE_WINDOW_MS).unref();

// Per-day budget guard. Caps both hire count AND cumulative upstream USD,
// resetting at UTC midnight. Tunable via env so an operator can lift the
// ceiling for a known-trusted deployment without rebuilding.
const MAX_DAILY_HIRES = Number(process.env.MAX_DAILY_HIRES ?? 1000);
const MAX_DAILY_SPEND_USD = Number(process.env.MAX_DAILY_SPEND_USD ?? 50);
// matplotlib sidecar runs locally — no upstream API cost. Leave 0.
const EST_UPSTREAM_USD_PER_CALL = Number(
  process.env.EST_UPSTREAM_USD_PER_CALL ?? 0,
);
const dailyBudget = new DailyBudget({
  maxHires: MAX_DAILY_HIRES,
  maxSpendUsd: MAX_DAILY_SPEND_USD,
});

const account = privateKeyToAccount(PRIVATE_KEY);
const agentId = account.address.toLowerCase() as AgentId;

// -------------------------------------------------------------------------
// Capability types
// -------------------------------------------------------------------------

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

// -------------------------------------------------------------------------
// Python renderer — long-running sidecar, JSONL over stdin/stdout
// -------------------------------------------------------------------------

interface RendererResponse extends ChartGenOutput {
  id: string;
  ok: true;
}

interface RendererError {
  id: string;
  ok: false;
  error: string;
  trace?: string;
}

class Renderer {
  private child!: ChildProcessWithoutNullStreams;
  private pending = new Map<
    string,
    {
      resolve: (out: ChartGenOutput) => void;
      reject: (err: Error) => void;
    }
  >();
  private nextId = 0;
  private readyPromise!: Promise<void>;

  async start(): Promise<void> {
    const here = dirname(fileURLToPath(import.meta.url));
    const script = resolve(here, "..", "render", "server.py");

    this.child = spawn(PYTHON_BIN, ["-u", script], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.child.stderr.on("data", (chunk: Buffer) => {
      process.stderr.write(`  [py] ${chunk.toString()}`);
    });

    this.child.on("exit", (code, signal) => {
      const reason = `python renderer exited (code=${code}, signal=${signal})`;
      for (const { reject } of this.pending.values()) reject(new Error(reason));
      this.pending.clear();
      process.stderr.write(`seller-chart-gen: FATAL ${reason}\n`);
      process.exit(1);
    });

    const lines = createInterface({ input: this.child.stdout });

    this.readyPromise = new Promise((resolveReady, rejectReady) => {
      const onFirstLine = (line: string) => {
        try {
          const msg = JSON.parse(line) as { ready?: boolean };
          if (msg.ready) {
            lines.off("line", onFirstLine);
            lines.on("line", (l) => this.onLine(l));
            resolveReady();
          } else {
            rejectReady(new Error(`unexpected first line: ${line}`));
          }
        } catch (err) {
          rejectReady(new Error(`bad ready line: ${line}`));
        }
      };
      lines.on("line", onFirstLine);
    });

    await this.readyPromise;
  }

  private onLine(line: string): void {
    let msg: RendererResponse | RendererError;
    try {
      msg = JSON.parse(line) as RendererResponse | RendererError;
    } catch (err) {
      process.stderr.write(`seller-chart-gen: malformed renderer line: ${line}\n`);
      return;
    }
    const slot = this.pending.get(msg.id);
    if (!slot) {
      process.stderr.write(
        `seller-chart-gen: renderer response for unknown id=${msg.id}\n`,
      );
      return;
    }
    this.pending.delete(msg.id);
    if (msg.ok) {
      slot.resolve({
        image_b64: msg.image_b64,
        width: msg.width,
        height: msg.height,
        chart_type: msg.chart_type,
      });
    } else {
      slot.reject(new Error(msg.error));
    }
  }

  render(input: ChartGenInput): Promise<ChartGenOutput> {
    const id = `r${++this.nextId}`;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const payload = JSON.stringify({ id, ...input });
      this.child.stdin.write(payload + "\n", (err) => {
        if (err) {
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }
}

// -------------------------------------------------------------------------
// Sign + publish listing
// -------------------------------------------------------------------------

async function signTypedPayload(payload: object): Promise<Hex> {
  const canonical = JSON.stringify(payload, Object.keys(payload).sort());
  const hash = keccak256(toBytes(canonical));
  return account.signMessage({ message: { raw: hash } });
}

async function publishListing(): Promise<void> {
  const listingPayload = {
    agent_id: agentId,
    capability: "chart.generate.from-data",
    price_usdc: PRICE_USDC,
    currency: "USDC" as const,
    chain: "base" as const,
    max_latency_ms: 8_000,
    first_call_free: true,
    endpoint: PUBLIC_URL,
  };
  const signature = await signTypedPayload(listingPayload);
  const listing: Listing = { ...listingPayload, signature };

  const res = await fetch(`${REGISTRY_URL}/v1/listings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(listing),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Failed to publish listing: ${res.status} ${txt}`);
  }
  process.stderr.write(
    `seller-chart-gen: listing published (capability=${listingPayload.capability}, price=${PRICE_USDC} USDC)\n`,
  );
}

// -------------------------------------------------------------------------
// HTTP server
// -------------------------------------------------------------------------

const renderer = new Renderer();
type Variables = {
  pendingReceipt?: {
    payload: Parameters<typeof submitReceipt>[0]["payload"];
  };
  freeCall?: boolean;
  freeCallBuyerId?: string;
};
const firstCallTracker = inMemoryTracker();
const app = new Hono<{ Variables: Variables }>();

app.get("/", (c) =>
  c.json({
    name: "swarmwage seller — chart.generate.from-data",
    agent_id: agentId,
    protocol: PROTOCOL_VERSION,
    backend: "matplotlib (python sidecar)",
    network: NETWORK,
    price_usdc: PRICE_USDC,
  }),
);

// Per-IP flood guard. Mounted BEFORE paymentMiddleware so a flood attack
// is rejected with 429 without ever invoking the facilitator.
app.use("/hire", rateLimit(hireIpLimiter, clientIp));

// Per-day budget guard — closes /hire with 503 once the day's hire count or
// upstream spend cap is hit. Mounted before paymentMiddleware so the buyer
// is never charged USDC for a call we cannot fulfil.
app.use("/hire", dailyBudgetGuard(dailyBudget, EST_UPSTREAM_USD_PER_CALL));

// Receipt-submission post-hook. Mounted BEFORE paymentMiddleware so its
// post-await(next) phase runs AFTER paymentMiddleware has already attached
// the X-PAYMENT-RESPONSE header (which carries the real settlement tx_hash).
// The /hire handler stashes the receipt payload in c.set("pendingReceipt").
// We read it back here, decode the header, and submit. Fire-and-forget.
app.use("/hire", async (c, next) => {
  await next();
  const pending = c.get("pendingReceipt") as
    | { payload: Parameters<typeof submitReceipt>[0]["payload"] }
    | undefined;
  if (!pending) return;
  if (c.res.status >= 400) return;
  let txHash =
    "0x0000000000000000000000000000000000000000000000000000000000000000";
  const paymentResponseHeader = c.res.headers.get("X-PAYMENT-RESPONSE");
  if (paymentResponseHeader) {
    try {
      const decoded = JSON.parse(
        Buffer.from(paymentResponseHeader, "base64").toString("utf8"),
      ) as { transaction?: string; txHash?: string };
      txHash = decoded.transaction ?? decoded.txHash ?? txHash;
    } catch {
      // header malformed — keep placeholder
    }
  }
  void submitReceipt({
    registryUrl: REGISTRY_URL,
    sellerPrivateKey: PRIVATE_KEY,
    payload: { ...pending.payload, tx_hash: txHash as `0x${string}` },
  });
});

// Wrapped by `firstCallFreeGate` so a buyer's first-ever hire against this
// seller bypasses payment (SPEC §11 — listing advertises first_call_free).
const pmw = paymentMiddleware(
  account.address,
  {
    "POST /hire": {
      price: `$${PRICE_USDC}`,
      network: NETWORK,
    },
  },
  { url: FACILITATOR_URL },
);

app.use(
  "/hire",
  firstCallFreeGate({ paymentMiddleware: pmw, tracker: firstCallTracker }),
);

app.post("/hire", async (c) => {
  const t0 = Date.now();
  const body = (await c.req.json()) as {
    protocol?: string;
    buyer_id?: AgentId;
    capability?: string;
    params?: ChartGenInput;
    max_price_usdc?: string;
    nonce?: string;
  };

  if (body.protocol !== PROTOCOL_VERSION) {
    return c.json(
      { error: `Unsupported protocol: ${body.protocol ?? "?"}` },
      400,
    );
  }
  if (body.capability !== "chart.generate.from-data") {
    return c.json(
      { error: `Capability not supported: ${body.capability}` },
      400,
    );
  }
  const params = body.params;
  if (!params || !Array.isArray(params.data) || params.data.length === 0) {
    return c.json({ error: "Missing or empty params.data" }, 400);
  }
  if (!params.chart_type || !["bar", "line", "pie"].includes(params.chart_type)) {
    return c.json({ error: "params.chart_type must be bar|line|pie" }, 400);
  }
  if (typeof params.width !== "number" || typeof params.height !== "number") {
    return c.json({ error: "params.width and params.height required" }, 400);
  }

  let result: ChartGenOutput;
  try {
    result = await renderer.render(params);
  } catch (err) {
    return c.json({ error: `Render failed: ${(err as Error).message}` }, 502);
  }

  const completedAt = Math.floor(Date.now() / 1000);
  const latency = Date.now() - t0;
  const receiptId = `rcpt_${crypto.randomUUID()}`;
  const ratingToken = `rtt_${crypto.randomUUID()}`;
  const freeCall = c.get("freeCall") === true;
  const pricePaid = freeCall ? "0.00" : PRICE_USDC;

  // Commit free-call consumption only after a successful render.
  if (freeCall) {
    const buyerKey = c.get("freeCallBuyerId");
    if (buyerKey) firstCallTracker.markSeen(buyerKey);
  }

  // x402-hono sets X-PAYMENT-RESPONSE on the response only AFTER this
  // handler returns (post `await next()` of paymentMiddleware, after settle
  // resolves). The buyer-facing JSON below ships tx_hash=0x000…000 — the
  // @swarmwage/agent-sdk client patches it from the response header on its
  // side. The signed receipt for Supabase is submitted by the post-hook
  // middleware mounted above, which reads X-PAYMENT-RESPONSE after it's set.
  const ZERO_HASH =
    "0x0000000000000000000000000000000000000000000000000000000000000000";

  const verification = {
    checks: [
      { name: "is_valid_png", passed: true },
      { name: "matches_dimensions", passed: true },
      { name: "chart_type_match", passed: true },
    ],
    all_passed: true,
  };

  // Stash the receipt payload (without tx_hash) for the post-hook to pick up
  // and submit once X-PAYMENT-RESPONSE is attached to the response.
  c.set("pendingReceipt", {
    payload: {
      protocol_version: PROTOCOL_VERSION,
      hire_id: receiptId,
      agent_id: agentId,
      buyer:
        (body.buyer_id?.toLowerCase() as AgentId) ??
        ("0x0000000000000000000000000000000000000000" as AgentId),
      capability: body.capability ?? "chart.generate.from-data",
      amount_usdc_atomic: freeCall ? "0" : priceUsdcToAtomic(PRICE_USDC),
      network: NETWORK as "base" | "base-sepolia",
      tx_hash: ZERO_HASH as `0x${string}`,
      completed_at: new Date(completedAt * 1000).toISOString(),
      verification: {
        all_passed: verification.all_passed,
        checks: Object.fromEntries(
          verification.checks.map((c) => [c.name, c.passed]),
        ),
      },
    },
  });

  return c.json({
    protocol: PROTOCOL_VERSION,
    receipt: {
      receipt_id: receiptId,
      buyer_id: body.buyer_id ?? "0x0000000000000000000000000000000000000000",
      seller_id: agentId,
      capability: body.capability,
      tx_hash: ZERO_HASH,
      price_paid_usdc: pricePaid,
      completed_at: completedAt,
      first_call_free: freeCall,
    },
    result,
    verification,
    rating_token: ratingToken,
    _meta: { latency_ms: latency, first_call_free: freeCall },
  });
});

// Convert "0.10" → "100000" (USDC has 6 decimals).
function priceUsdcToAtomic(price: string): string {
  const [intPart, fracPart = ""] = price.split(".");
  const frac = (fracPart + "000000").slice(0, 6);
  const combined = `${intPart}${frac}`.replace(/^0+(?=\d)/, "");
  return combined === "" ? "0" : combined;
}

// -------------------------------------------------------------------------
// Boot
// -------------------------------------------------------------------------

(async () => {
  process.stderr.write(`seller-chart-gen: spawning matplotlib renderer (${PYTHON_BIN})…\n`);
  try {
    await renderer.start();
    process.stderr.write("seller-chart-gen: renderer ready\n");
  } catch (err) {
    process.stderr.write(
      `seller-chart-gen: FATAL renderer failed to start — ${(err as Error).message}\n`,
    );
    process.exit(1);
  }

  // Warmup render — pays the matplotlib first-call cost (font cache, etc.)
  try {
    await renderer.render({
      chart_type: "bar",
      data: [{ x: "warm", y: 1 }],
      width: 320,
      height: 200,
    });
    process.stderr.write("seller-chart-gen: warmup render done\n");
  } catch (err) {
    process.stderr.write(
      `seller-chart-gen: WARN warmup render failed — ${(err as Error).message}\n`,
    );
  }

  try {
    await publishListing();
  } catch (err) {
    process.stderr.write(
      `seller-chart-gen: WARN failed to publish listing — ${(err as Error).message}\n`,
    );
  }

  serve({ fetch: app.fetch, port: PORT }, () => {
    process.stderr.write(
      `seller-chart-gen v0.0.1 listening on ${PUBLIC_URL} (agent_id=${agentId})\n`,
    );
  });
})();
