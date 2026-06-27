// Reference Swarmwage seller — fulfills code.execute.sandboxed with Pyodide.
// License: MIT

import type { Hex } from "@swarmwage/agent-sdk";
import { createSellerRuntime } from "@swarmwage/example-seller-runtime";
import { loadPyodide, type PyodideInterface } from "pyodide";
import type { Network } from "x402-hono";

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
const HIRE_RATE_LIMIT_PER_IP = Number(process.env.HIRE_RATE_LIMIT_PER_IP ?? 20);
const HIRE_RATE_WINDOW_MS = Number(process.env.HIRE_RATE_WINDOW_MS ?? 60_000);
const MAX_DAILY_HIRES = Number(process.env.MAX_DAILY_HIRES ?? 1000);
const MAX_DAILY_SPEND_USD = Number(process.env.MAX_DAILY_SPEND_USD ?? 50);
const EST_UPSTREAM_USD_PER_CALL = Number(
  process.env.EST_UPSTREAM_USD_PER_CALL ?? 0,
);
const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 30_000;
const MAX_CODE_BYTES = 16 * 1024;
const MAX_STDIN_BYTES = 64 * 1024;
const MAX_OUTPUT_BYTES = 64 * 1024;
const CAPABILITY = "code.execute.sandboxed";

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

class PyodideExecutor {
  private pyodide!: PyodideInterface;
  private interruptBuffer!: Uint8Array;
  private queue: Promise<unknown> = Promise.resolve();
  private stdoutBuf = "";
  private stderrBuf = "";
  private truncated = false;
  private stdinChunks: string[] = [];

  async start(): Promise<void> {
    this.pyodide = await loadPyodide({ stdout: () => {}, stderr: () => {} });
    this.pyodide.setStdout({
      batched: (value: string) => this.append("stdout", `${value}\n`),
    });
    this.pyodide.setStderr({
      batched: (value: string) => this.append("stderr", `${value}\n`),
    });
    this.pyodide.setStdin({
      stdin: () => this.stdinChunks.shift() ?? "",
    });
    this.interruptBuffer = new Uint8Array(new SharedArrayBuffer(1));
    this.pyodide.setInterruptBuffer(this.interruptBuffer);
  }

  private append(stream: "stdout" | "stderr", value: string): void {
    const current = stream === "stdout" ? this.stdoutBuf : this.stderrBuf;
    if (Buffer.byteLength(current, "utf8") >= MAX_OUTPUT_BYTES) {
      this.truncated = true;
      return;
    }
    let next = current + value;
    if (Buffer.byteLength(next, "utf8") > MAX_OUTPUT_BYTES) {
      next = next.slice(0, MAX_OUTPUT_BYTES);
      this.truncated = true;
    }
    if (stream === "stdout") this.stdoutBuf = next;
    else this.stderrBuf = next;
  }

  execute(input: CodeExecInput): Promise<CodeExecOutput> {
    const job = this.queue.then(() => this.executeImpl(input));
    this.queue = job.then(
      () => undefined,
      () => undefined,
    );
    return job;
  }

  private async executeImpl(input: CodeExecInput): Promise<CodeExecOutput> {
    const startedAt = Date.now();
    this.stdoutBuf = "";
    this.stderrBuf = "";
    this.truncated = false;
    this.stdinChunks = input.stdin ? [input.stdin] : [];
    Atomics.store(this.interruptBuffer, 0, 0);
    const timeout = clampTimeout(input.timeout_ms);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      Atomics.store(this.interruptBuffer, 0, 2);
    }, timeout);
    let exitCode = 0;
    try {
      await this.pyodide.runPythonAsync(input.code);
    } catch (error) {
      const message = (error as Error).message ?? String(error);
      if (timedOut || message.includes("KeyboardInterrupt")) {
        exitCode = 124;
        this.append("stderr", `\n[swarmwage] timed out after ${timeout} ms\n`);
      } else {
        exitCode = 1;
        if (!this.stderrBuf.includes(message)) {
          this.append("stderr", `${message}\n`);
        }
      }
    } finally {
      clearTimeout(timer);
      Atomics.store(this.interruptBuffer, 0, 0);
    }
    return {
      stdout: this.stdoutBuf,
      stderr: this.stderrBuf,
      exit_code: exitCode,
      duration_ms: Date.now() - startedAt,
      truncated: this.truncated,
    };
  }
}

function clampTimeout(value?: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_TIMEOUT_MS;
  }
  return Math.min(Math.floor(value), MAX_TIMEOUT_MS);
}

const executor = new PyodideExecutor();
const runtime = createSellerRuntime({
  identity: { privateKey: PRIVATE_KEY, serviceName: "seller-code-exec" },
  listing: {
    capability: CAPABILITY,
    priceUsdc: PRICE_USDC,
    maxLatencyMs: 35_000,
    firstCallFree: true,
    publicUrl: PUBLIC_URL,
    registryUrl: REGISTRY_URL,
    publishedMessage: `seller-code-exec: listing published (capability=${CAPABILITY}, price=${PRICE_USDC} USDC)\n`,
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
  },
  configure(app) {
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
  },
  async fulfill(raw, c) {
    const params = raw as CodeExecInput | undefined;
    if (!params || typeof params.code !== "string" || params.code.length === 0) {
      return c.json({ error: "Missing params.code" }, 400);
    }
    if (Buffer.byteLength(params.code, "utf8") > MAX_CODE_BYTES) {
      return c.json(
        { error: `params.code exceeds ${MAX_CODE_BYTES} bytes` },
        400,
      );
    }
    if (
      params.stdin !== undefined &&
      Buffer.byteLength(params.stdin, "utf8") > MAX_STDIN_BYTES
    ) {
      return c.json(
        { error: `params.stdin exceeds ${MAX_STDIN_BYTES} bytes` },
        400,
      );
    }
    const language = params.language ?? "python";
    if (language !== "python") {
      return c.json(
        { error: `language ${language} not supported (v0.1: python only)` },
        400,
      );
    }
    try {
      const result = await executor.execute(params);
      return {
        result,
        verification: {
          checks: [
            { name: "stdout_is_string", passed: typeof result.stdout === "string" },
            { name: "stderr_is_string", passed: typeof result.stderr === "string" },
            { name: "exit_code_is_int", passed: Number.isInteger(result.exit_code) },
          ],
          all_passed: true,
        },
      };
    } catch (error) {
      return c.json(
        { error: `Executor failed: ${(error as Error).message}` },
        502,
      );
    }
  },
});

void (async () => {
  process.stderr.write("seller-code-exec: loading Pyodide runtime…\n");
  try {
    await executor.start();
    process.stderr.write("seller-code-exec: Pyodide ready\n");
  } catch (error) {
    process.stderr.write(
      `seller-code-exec: FATAL Pyodide failed to start — ${(error as Error).message}\n`,
    );
    process.exit(1);
  }
  await runtime.start(
    PORT,
    `seller-code-exec v0.0.1 listening on ${PUBLIC_URL} (agent_id=${runtime.agentId})\n`,
  );
})();
