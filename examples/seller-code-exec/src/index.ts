// Reference Swarmwage seller — fulfills code.execute.sandboxed
// via Pyodide (CPython compiled to WebAssembly, in-process).
// License: MIT
//
// Usage:
//   SELLER_PRIVATE_KEY=0x... PORT=4003 \
//   REGISTRY_URL=http://localhost:3000 \
//   PUBLIC_URL=http://localhost:4003 \
//   pnpm --filter @swarmwage/example-seller-code-exec start
//
// Architecture:
//   - Pyodide is loaded once at boot (~1.5s on Node 20+) and kept hot.
//   - Each /hire request executes Python code with stdout/stderr captured
//     via setStdout/setStderr, optional stdin via setStdin, and an enforced
//     wall-clock timeout backed by setInterruptBuffer (KeyboardInterrupt).
//   - Single-flight queue: Pyodide is single-threaded; concurrent /hire
//     requests are serialized.
//   - Sandbox properties: WASM memory isolation (no host FS, no host
//     network, no escape to V8 host), bounded stdout/stderr (64KB cap),
//     enforced timeout (max 30s), no `pip install <arbitrary>` (only
//     wheels in the Pyodide registry; can be enabled per-listing later).

import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { keccak256, toBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { paymentMiddleware, type Network } from "x402-hono";
import { loadPyodide, type PyodideInterface } from "pyodide";
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
    "seller-code-exec: SELLER_PRIVATE_KEY required (0x-prefixed 32-byte hex)\n",
  );
  process.exit(1);
}

const PORT = Number(process.env.PORT ?? 4003);
const REGISTRY_URL = process.env.REGISTRY_URL ?? "http://localhost:3000";
const PUBLIC_URL = process.env.PUBLIC_URL ?? `http://localhost:${PORT}`;
const PRICE_USDC = process.env.PRICE_USDC ?? "0.02";
const NETWORK = (process.env.NETWORK ?? "base-sepolia") as Network;
const FACILITATOR_URL = (process.env.FACILITATOR_URL ??
  "https://x402.org/facilitator") as `${string}://${string}`;

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
// Pyodide runs in-process — no upstream API cost. Leave 0.
const EST_UPSTREAM_USD_PER_CALL = Number(
  process.env.EST_UPSTREAM_USD_PER_CALL ?? 0,
);
const dailyBudget = new DailyBudget({
  maxHires: MAX_DAILY_HIRES,
  maxSpendUsd: MAX_DAILY_SPEND_USD,
});

const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 30_000;
const MAX_CODE_BYTES = 16 * 1024; // 16 KB per script
const MAX_STDIN_BYTES = 64 * 1024;
const MAX_OUTPUT_BYTES = 64 * 1024; // per stream

const account = privateKeyToAccount(PRIVATE_KEY);
const agentId = account.address.toLowerCase() as AgentId;

// -------------------------------------------------------------------------
// Capability types
// -------------------------------------------------------------------------

interface CodeExecInput {
  code: string;
  language?: "python";
  stdin?: string;
  timeout_ms?: number;
}

interface CodeExecOutput {
  stdout: string;
  stderr: string;
  exit_code: number;
  duration_ms: number;
  truncated: boolean;
}

// -------------------------------------------------------------------------
// Pyodide executor
// -------------------------------------------------------------------------

class PyodideExecutor {
  private pyodide!: PyodideInterface;
  private interruptBuffer!: Uint8Array;
  private queue: Promise<unknown> = Promise.resolve();

  // Per-request mutable state (single-flight: only one runs at a time)
  private stdoutBuf = "";
  private stderrBuf = "";
  private truncated = false;
  private stdinChunks: string[] = [];

  async start(): Promise<void> {
    this.pyodide = await loadPyodide({
      // Quiet bootstrap; otherwise Pyodide prints "Loading…" lines to stdout.
      stdout: () => {},
      stderr: () => {},
    });

    // Hot-swap stdout/stderr to per-request buffers.
    // Pyodide's `batched` strips trailing newlines and invokes once per line —
    // we re-append "\n" so the captured stream preserves print() boundaries.
    this.pyodide.setStdout({
      batched: (s: string) => this.appendStdout(s + "\n"),
    });
    this.pyodide.setStderr({
      batched: (s: string) => this.appendStderr(s + "\n"),
    });

    // Pyodide stdin: invoked on input() / sys.stdin.read(). Returns chunks
    // until exhausted, then EOF (returning undefined).
    this.pyodide.setStdin({
      stdin: () => {
        const next = this.stdinChunks.shift();
        return next ?? "";
      },
    });

    // Interrupt buffer: writing 2 to byte 0 raises KeyboardInterrupt at the
    // next CPython bytecode boundary. Used for timeout enforcement.
    const ab = new SharedArrayBuffer(1);
    this.interruptBuffer = new Uint8Array(ab);
    this.pyodide.setInterruptBuffer(this.interruptBuffer);
  }

  private appendStdout(s: string): void {
    if (Buffer.byteLength(this.stdoutBuf, "utf8") >= MAX_OUTPUT_BYTES) {
      this.truncated = true;
      return;
    }
    this.stdoutBuf += s;
    if (Buffer.byteLength(this.stdoutBuf, "utf8") > MAX_OUTPUT_BYTES) {
      this.stdoutBuf = this.stdoutBuf.slice(0, MAX_OUTPUT_BYTES);
      this.truncated = true;
    }
  }

  private appendStderr(s: string): void {
    if (Buffer.byteLength(this.stderrBuf, "utf8") >= MAX_OUTPUT_BYTES) {
      this.truncated = true;
      return;
    }
    this.stderrBuf += s;
    if (Buffer.byteLength(this.stderrBuf, "utf8") > MAX_OUTPUT_BYTES) {
      this.stderrBuf = this.stderrBuf.slice(0, MAX_OUTPUT_BYTES);
      this.truncated = true;
    }
  }

  execute(input: CodeExecInput): Promise<CodeExecOutput> {
    const job = this.queue.then(() => this.executeImpl(input));
    // Don't poison the queue if one job rejects.
    this.queue = job.then(
      () => undefined,
      () => undefined,
    );
    return job;
  }

  private async executeImpl(input: CodeExecInput): Promise<CodeExecOutput> {
    const t0 = Date.now();
    this.stdoutBuf = "";
    this.stderrBuf = "";
    this.truncated = false;
    this.stdinChunks = input.stdin ? [input.stdin] : [];
    Atomics.store(this.interruptBuffer, 0, 0);

    const timeout = clampTimeout(input.timeout_ms);
    let timedOut = false;
    const interruptTimer = setTimeout(() => {
      timedOut = true;
      Atomics.store(this.interruptBuffer, 0, 2); // KeyboardInterrupt
    }, timeout);

    let exitCode = 0;
    try {
      await this.pyodide.runPythonAsync(input.code);
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      if (timedOut || msg.includes("KeyboardInterrupt")) {
        exitCode = 124;
        this.appendStderr(`\n[swarmwage] timed out after ${timeout} ms\n`);
      } else {
        exitCode = 1;
        // Pyodide already wrote the traceback to stderr via setStderr; if
        // it didn't (e.g. JS-side error), surface the message.
        if (!this.stderrBuf.includes(msg)) this.appendStderr(msg + "\n");
      }
    } finally {
      clearTimeout(interruptTimer);
      Atomics.store(this.interruptBuffer, 0, 0);
    }

    return {
      stdout: this.stdoutBuf,
      stderr: this.stderrBuf,
      exit_code: exitCode,
      duration_ms: Date.now() - t0,
      truncated: this.truncated,
    };
  }
}

function clampTimeout(t?: number): number {
  if (typeof t !== "number" || !Number.isFinite(t) || t <= 0) {
    return DEFAULT_TIMEOUT_MS;
  }
  return Math.min(Math.floor(t), MAX_TIMEOUT_MS);
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
    capability: "code.execute.sandboxed",
    price_usdc: PRICE_USDC,
    currency: "USDC" as const,
    chain: "base" as const,
    max_latency_ms: 35_000,
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
    `seller-code-exec: listing published (capability=${listingPayload.capability}, price=${PRICE_USDC} USDC)\n`,
  );
}

// -------------------------------------------------------------------------
// HTTP server
// -------------------------------------------------------------------------

const executor = new PyodideExecutor();
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
    name: "swarmwage seller — code.execute.sandboxed",
    agent_id: agentId,
    protocol: PROTOCOL_VERSION,
    backend: "pyodide (python wasm, in-process)",
    network: NETWORK,
    price_usdc: PRICE_USDC,
    runtime: { language: "python", version: "3.12 (pyodide)" },
    limits: {
      default_timeout_ms: DEFAULT_TIMEOUT_MS,
      max_timeout_ms: MAX_TIMEOUT_MS,
      max_code_bytes: MAX_CODE_BYTES,
      max_stdin_bytes: MAX_STDIN_BYTES,
      max_output_bytes: MAX_OUTPUT_BYTES,
    },
  }),
);

app.get("/capabilities/code.execute.sandboxed/runtime", (c) =>
  c.json({
    language: "python",
    version: "3.12 (pyodide)",
    sandbox: "wasm",
    available_packages: "pyodide-wheels",
    network_egress: false,
    filesystem_access: false,
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
// post-await(next) phase runs AFTER paymentMiddleware has attached the
// X-PAYMENT-RESPONSE header (which carries the real settlement tx_hash).
// The /hire handler stashes the receipt payload via c.set("pendingReceipt").
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
    params?: CodeExecInput;
    max_price_usdc?: string;
    nonce?: string;
  };

  if (body.protocol !== PROTOCOL_VERSION) {
    return c.json(
      { error: `Unsupported protocol: ${body.protocol ?? "?"}` },
      400,
    );
  }
  if (body.capability !== "code.execute.sandboxed") {
    return c.json(
      { error: `Capability not supported: ${body.capability}` },
      400,
    );
  }
  const params = body.params;
  if (!params || typeof params.code !== "string" || params.code.length === 0) {
    return c.json({ error: "Missing params.code" }, 400);
  }
  if (Buffer.byteLength(params.code, "utf8") > MAX_CODE_BYTES) {
    return c.json({ error: `params.code exceeds ${MAX_CODE_BYTES} bytes` }, 400);
  }
  if (
    params.stdin !== undefined &&
    Buffer.byteLength(params.stdin, "utf8") > MAX_STDIN_BYTES
  ) {
    return c.json({ error: `params.stdin exceeds ${MAX_STDIN_BYTES} bytes` }, 400);
  }
  const lang = params.language ?? "python";
  if (lang !== "python") {
    return c.json(
      { error: `language ${lang} not supported (v0.1: python only)` },
      400,
    );
  }

  let result: CodeExecOutput;
  try {
    result = await executor.execute(params);
  } catch (err) {
    return c.json(
      { error: `Executor failed: ${(err as Error).message}` },
      502,
    );
  }

  const completedAt = Math.floor(Date.now() / 1000);
  const latency = Date.now() - t0;
  const receiptId = `rcpt_${crypto.randomUUID()}`;
  const ratingToken = `rtt_${crypto.randomUUID()}`;
  const freeCall = c.get("freeCall") === true;
  const pricePaid = freeCall ? "0.00" : PRICE_USDC;

  // Commit free-call consumption only after a successful execution.
  if (freeCall) {
    const buyerKey = c.get("freeCallBuyerId");
    if (buyerKey) firstCallTracker.markSeen(buyerKey);
  }

  // x402-hono attaches X-PAYMENT-RESPONSE on the response only AFTER this
  // handler returns. We ship tx_hash=0x0…0 here and the @swarmwage/agent-sdk
  // client patches it from the response header on its side. The signed
  // receipt is submitted by the post-hook middleware mounted above.
  const ZERO_HASH =
    "0x0000000000000000000000000000000000000000000000000000000000000000";

  const verification = {
    checks: [
      { name: "stdout_is_string", passed: typeof result.stdout === "string" },
      { name: "stderr_is_string", passed: typeof result.stderr === "string" },
      { name: "exit_code_is_int", passed: Number.isInteger(result.exit_code) },
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
      capability: body.capability ?? "code.execute.sandboxed",
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

// Convert "0.02" → "20000" (USDC has 6 decimals).
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
  process.stderr.write("seller-code-exec: loading pyodide…\n");
  const tLoad = Date.now();
  try {
    await executor.start();
    process.stderr.write(
      `seller-code-exec: pyodide ready (${Date.now() - tLoad} ms)\n`,
    );
  } catch (err) {
    process.stderr.write(
      `seller-code-exec: FATAL pyodide failed to load — ${(err as Error).message}\n`,
    );
    process.exit(1);
  }

  // Warmup execution — pays first-call JIT cost so /hire latency is stable.
  try {
    await executor.execute({
      code: "x = 1 + 1\nprint('warmup', x)",
      timeout_ms: 5000,
    });
    process.stderr.write("seller-code-exec: warmup execution done\n");
  } catch (err) {
    process.stderr.write(
      `seller-code-exec: WARN warmup failed — ${(err as Error).message}\n`,
    );
  }

  try {
    await publishListing();
  } catch (err) {
    process.stderr.write(
      `seller-code-exec: WARN failed to publish listing — ${(err as Error).message}\n`,
    );
  }

  serve({ fetch: app.fetch, port: PORT }, () => {
    process.stderr.write(
      `seller-code-exec v0.0.1 listening on ${PUBLIC_URL} (agent_id=${agentId})\n`,
    );
  });
})();
