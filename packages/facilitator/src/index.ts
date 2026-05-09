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

  app.get("/health", async (c) => {
    let ethBalanceWei: string | null = null;
    try {
      const balance = await relay.gasBalance();
      ethBalanceWei = balance.toString();
    } catch {
      // RPC unreachable. Body keeps the structured payload; status flips to
      // 503 so load balancers drain this instance instead of routing traffic.
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
  serve({ fetch: app.fetch, port: env.port }, (info) => {
    process.stderr.write(
      `swarmwage-facilitator v0.0.1 listening on http://localhost:${info.port} (network=${env.network}, gas_wallet=${relay.account.address}, store=${storeKind}, min_reserve_wei=${env.minGasReserveWei}, max_gas_per_hour_wei=${env.maxGasPerHourWei})\n`,
    );
  });
}

export { app };
