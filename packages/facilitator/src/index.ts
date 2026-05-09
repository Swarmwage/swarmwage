// Swarmwage Facilitator — gas-relay-only x402 facilitator
// License: BUSL-1.1
//
// HTTP entry point. Wires the relay, log store, and Hono routes.
// The facilitator wallet ONLY pays ETH for gas. The USDC moves directly
// buyer → seller via the USDC contract; this service never holds, custodies,
// or transfers USDC at any point in the flow.

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { logger as honoLogger } from "hono/logger";

import { loadEnv } from "./env.js";
import { GasGuard } from "./gas-guard.js";
import {
  clientIp,
  rateLimit,
  SlidingWindowLimiter,
} from "./rate-limit.js";
import { createRelay } from "./relay.js";
import { createSettleHandler } from "./routes/settle.js";
import { createVerifyHandler } from "./routes/verify.js";
import {
  InMemoryStore,
  PostgresStore,
  type FacilitatorLogStore,
} from "./store.js";
import {
  SupportedPaymentKindsResponseSchema,
  x402Versions,
} from "./types.js";

export interface FacilitatorAppDeps {
  relay: ReturnType<typeof createRelay>;
  store: FacilitatorLogStore;
  /**
   * Optional override for the per-IP /settle limiter. Tests pass a tight
   * limiter to exercise the 429 path without flooding. Defaults to
   * 20 requests / minute.
   */
  settleIpLimiter?: SlidingWindowLimiter;
  /**
   * Optional override for the per-IP /verify limiter. Verify is read-only
   * (no gas spent), so the default ceiling is higher: 60 requests / minute.
   */
  verifyIpLimiter?: SlidingWindowLimiter;
  /**
   * Optional override for the per-buyer-address /settle limiter. Defaults
   * to 5 requests / minute. Enforced inside the route handler after body
   * parsing because the buyer address is only known once the payload is
   * decoded.
   */
  settleAddressLimiter?: SlidingWindowLimiter;
  /**
   * Optional override for the bankroll kill-switch. Tests can inject a
   * tight cap to exercise the 503 path. When omitted, the app builds a
   * permissive guard (effectively no-op); the production boot path below
   * wires real reserve and hourly cap values from env.
   */
  gasGuard?: GasGuard;
}

export function createApp(deps: FacilitatorAppDeps) {
  const { relay, store } = deps;
  const settleIpLimiter =
    deps.settleIpLimiter ??
    new SlidingWindowLimiter({ limit: 20, windowMs: 60_000 });
  const verifyIpLimiter =
    deps.verifyIpLimiter ??
    new SlidingWindowLimiter({ limit: 60, windowMs: 60_000 });
  const settleAddressLimiter =
    deps.settleAddressLimiter ??
    new SlidingWindowLimiter({ limit: 5, windowMs: 60_000 });
  // Default guard is permissive: no-op when callers (e.g. unit tests)
  // omit the gasGuard dependency. The production boot below wires a
  // GasGuard with the operator-configured reserve floor and hourly cap.
  const gasGuard =
    deps.gasGuard ??
    new GasGuard({ minReserveWei: 0n, maxPerHourWei: 0n });
  const app = new Hono();

  app.use("*", honoLogger());
  app.use(
    "*",
    cors({
      origin: "*",
      allowMethods: ["GET", "POST", "OPTIONS"],
      allowHeaders: ["Content-Type", "X-PAYMENT"],
    }),
  );

  // Body cap. /verify and /settle carry an EIP-3009 authorization +
  // payment requirements; well under 32KB even with verbose payloads.
  app.use(
    "*",
    bodyLimit({
      maxSize: 32 * 1024,
      onError: (c) => c.json({ error: "Payload too large" }, 413),
    }),
  );

  app.get("/", (c) =>
    c.json({
      name: "swarmwage-facilitator",
      version: "0.0.1",
      role: "gas-relay-only x402 facilitator",
      network: relay.network,
      repository: "https://github.com/Swarmwage/swarmwage",
    }),
  );

  // 5-second TTL cache for the gas wallet balance read by /health. The
  // endpoint is CORS-open by design (operators monitor it from arbitrary
  // dashboards), so without a cache it is trivially RPC-amplifiable: a
  // malicious browser can spam it at high rate and exhaust the operator's
  // Alchemy quota without ever paying for a settle. /settle's reserve
  // check is intentionally NOT cached — that path defends the bankroll
  // floor and needs fresh balance; /health can tolerate 5s of staleness.
  const HEALTH_BALANCE_CACHE_MS = 5_000;
  let cachedHealthBalance: { ts: number; wei: bigint } | null = null;
  const readHealthBalance = async (): Promise<bigint> => {
    const now = Date.now();
    if (
      cachedHealthBalance &&
      now - cachedHealthBalance.ts < HEALTH_BALANCE_CACHE_MS
    ) {
      return cachedHealthBalance.wei;
    }
    const wei = await relay.gasBalance();
    cachedHealthBalance = { ts: now, wei };
    return wei;
  };

  app.get("/health", async (c) => {
    let ethBalanceWei: string | null = null;
    try {
      const balance = await readHealthBalance();
      ethBalanceWei = balance.toString();
    } catch (err) {
      // RPC unreachable. Body keeps the structured payload; status flips to
      // 503 so load balancers drain this instance instead of routing traffic.
      // Surface the underlying error to stderr — the operator should not
      // have to ssh in and grep route logs to learn why /health is failing.
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `facilitator.health.balance_rpc_error err=${JSON.stringify(msg)}\n`,
      );
    }
    const ok = ethBalanceWei !== null;
    const snap = gasGuard.snapshot();
    // reserve_breached is null when we couldn't read the balance — undefined
    // truth value rather than a false-negative. When the floor is disabled
    // (reserveWei == 0n) the field is always false because no balance fails
    // a non-existent floor.
    const balanceBig = ethBalanceWei !== null ? BigInt(ethBalanceWei) : null;
    const reserveBreached =
      balanceBig === null
        ? null
        : snap.reserveWei > 0n && balanceBig < snap.reserveWei;
    return c.json(
      {
        ok,
        network: relay.network,
        gas_wallet: relay.account.address,
        eth_balance_wei: ethBalanceWei,
        gas_guard: {
          hourly_used_wei: snap.hourlyUsedWei.toString(),
          hourly_cap_wei: snap.hourlyCapWei.toString(),
          hourly_used_pct: snap.hourlyUsedPct,
          reserve_wei: snap.reserveWei.toString(),
          reserve_breached: reserveBreached,
        },
      },
      ok ? 200 : 503,
    );
  });

  app.get("/supported", (c) => {
    const body = SupportedPaymentKindsResponseSchema.parse({
      kinds: [
        {
          x402Version: x402Versions[0],
          scheme: "exact",
          network: relay.network,
        },
      ],
    });
    return c.json(body);
  });

  app.post(
    "/verify",
    rateLimit(verifyIpLimiter, clientIp),
    createVerifyHandler({ relay, store }),
  );
  app.post(
    "/settle",
    rateLimit(settleIpLimiter, clientIp),
    createSettleHandler({
      relay,
      store,
      addressLimiter: settleAddressLimiter,
      gasGuard,
    }),
  );

  return app;
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

// Only run the listener when this module is the process entry point. This
// keeps the export usable from tests without binding a real port.
const isEntry =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  import.meta.url === `file://${process.argv[1]}`;

let app: ReturnType<typeof createApp> | undefined;

if (isEntry) {
  // Register safety handlers FIRST, before any user code runs. Without
  // these, a stray rejected promise or a synchronous throw from a route
  // handler can take the process down silently in modern Node — no log
  // line, no exit code reason, just a black box for the operator.
  process.on("unhandledRejection", (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    const stack =
      reason instanceof Error && reason.stack ? reason.stack : "";
    process.stderr.write(
      `facilitator.unhandled_rejection reason=${JSON.stringify(msg)} stack=${JSON.stringify(stack)}\n`,
    );
    process.exit(1);
  });
  process.on("uncaughtException", (err) => {
    process.stderr.write(
      `facilitator.uncaught_exception err=${JSON.stringify(err.message)} stack=${JSON.stringify(err.stack ?? "")}\n`,
    );
    process.exit(1);
  });

  const env = loadEnv();
  const relay = createRelay(env);
  const store: FacilitatorLogStore = env.databaseUrl
    ? new PostgresStore({
        connectionString: env.databaseUrl,
        onError: (err) =>
          process.stderr.write(
            `facilitator.log_write_error ${err instanceof Error ? err.message : String(err)}\n`,
          ),
      })
    : new InMemoryStore();
  const storeKind = env.databaseUrl ? "postgres" : "memory";
  const gasGuard = new GasGuard({
    minReserveWei: env.minGasReserveWei,
    maxPerHourWei: env.maxGasPerHourWei,
  });
  app = createApp({ relay, store, gasGuard });
  const httpServer = serve({ fetch: app.fetch, port: env.port }, (info) => {
    process.stderr.write(
      `swarmwage-facilitator v0.0.1 listening on http://localhost:${info.port} (network=${env.network}, gas_wallet=${relay.account.address}, store=${storeKind}, min_reserve_wei=${env.minGasReserveWei}, max_gas_per_hour_wei=${env.maxGasPerHourWei})\n`,
    );
  });

  // Graceful shutdown. SIGTERM/SIGINT (Hetzner redeploy, Ctrl-C, container
  // orchestrator) trigger the same sequence:
  //   1. stop accepting new connections (httpServer.close)
  //   2. drain in-flight settles up to SHUTDOWN_TIMEOUT_MS so on-chain
  //      state and DB log stay in sync — every settle in flight has
  //      already broadcast a tx, gas is already spent, and we owe the
  //      data layer the corresponding row
  //   3. close the Postgres pool
  //   4. exit (code 0 on clean drain, 1 on timeout)
  // Idempotent against repeated signals (two SIGTERMs in a row do not
  // collapse the in-flight wait).
  const SHUTDOWN_TIMEOUT_MS = 30_000;
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stderr.write(
      `facilitator.shutdown.start signal=${signal} in_flight=${relay.inFlightCount()}\n`,
    );
    await new Promise<void>((resolve) => {
      httpServer.close(() => resolve());
    });
    const deadline = Date.now() + SHUTDOWN_TIMEOUT_MS;
    while (relay.inFlightCount() > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
    }
    const remaining = relay.inFlightCount();
    if (remaining > 0) {
      process.stderr.write(
        `facilitator.shutdown.timeout in_flight=${remaining}\n`,
      );
    }
    if (store.close) {
      try {
        await store.close();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(
          `facilitator.shutdown.store_close_error err=${JSON.stringify(msg)}\n`,
        );
      }
    }
    process.stderr.write(`facilitator.shutdown.complete\n`);
    process.exit(remaining > 0 ? 1 : 0);
  };
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
}

export { app };
