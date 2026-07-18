// Swarmwage Indexer — read-only on-chain USDC Transfer indexer
// License: BUSL-1.1
//
// HTTP entry point. Wires the chain client, registry resolver, store, and
// indexer loop, and exposes a small Hono app for liveness checks.
//
// This service is read-only. It indexes public USDC `Transfer` events on
// Base. It does not custody, transfer, sign, or manage any funds.

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger as honoLogger } from "hono/logger";

import { createChainContext, type ChainContext } from "./chain.js";
import { loadEnv, type IndexerEnv } from "./env.js";
import { createExternalResolver, type ExternalResolver } from "./external.js";
import { createIndexer, type IndexerHandle, type IndexerLogger } from "./indexer.js";
import { createRegistryClient, type RegistryResolver } from "./registry.js";
import { InMemoryStore, PostgresStore, type IndexerStore } from "./store.js";

export interface IndexerAppDeps {
  chain: ChainContext;
  store: IndexerStore;
  indexer: IndexerHandle;
  storeKind: "memory" | "postgres";
}

export function createApp(deps: IndexerAppDeps) {
  const { chain, store, indexer, storeKind } = deps;
  const app = new Hono();

  app.use("*", honoLogger());
  app.use(
    "*",
    cors({
      origin: "*",
      allowMethods: ["GET", "OPTIONS"],
      allowHeaders: ["Content-Type"],
    }),
  );

  app.get("/", (c) =>
    c.json({
      name: "swarmwage-indexer",
      version: "0.0.1",
      role: "read-only USDC Transfer indexer",
      network: chain.network,
      chain_id: chain.chainId,
      repository: "https://github.com/Swarmwage/swarmwage",
    }),
  );

  app.get("/health", async (c) => {
    const last = indexer.lastIndexedBlock();
    return c.json({
      ok: last !== null,
      network: chain.network,
      chain_id: chain.chainId,
      last_indexed_block: last !== null ? last.toString() : null,
      lag_blocks: indexer.lagBlocks(),
      store_kind: storeKind,
    });
  });

  app.get("/metrics", async (c) => {
    const last = indexer.lastIndexedBlock();
    const total = await store.size();
    return c.json({
      transactions_total: total,
      last_indexed_block: last !== null ? last.toString() : null,
      lag_blocks: indexer.lagBlocks(),
      network: chain.network,
      chain_id: chain.chainId,
    });
  });

  return app;
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

function buildLogger(level: IndexerEnv["logLevel"]): IndexerLogger {
  const order: Record<IndexerEnv["logLevel"], number> = {
    debug: 10,
    info: 20,
    warn: 30,
    error: 40,
  };
  const min = order[level];
  function emit(
    lvl: IndexerEnv["logLevel"],
    msg: string,
    meta?: Record<string, unknown>,
  ) {
    if (order[lvl] < min) return;
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      level: lvl,
      msg,
      ...(meta ?? {}),
    });
    if (lvl === "error" || lvl === "warn") process.stderr.write(line + "\n");
    else process.stdout.write(line + "\n");
  }
  return {
    debug: (m, meta) => emit("debug", m, meta),
    info: (m, meta) => emit("info", m, meta),
    warn: (m, meta) => emit("warn", m, meta),
    error: (m, meta) => emit("error", m, meta),
  };
}

// Only run the listener when this module is the process entry point. This
// keeps the export usable from tests without binding a real port.
const isEntry =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  import.meta.url === `file://${process.argv[1]}`;

let app: ReturnType<typeof createApp> | undefined;

if (isEntry) {
  const env = loadEnv();
  const logger = buildLogger(env.logLevel);
  const chain = createChainContext({
    network: env.network,
    rpcUrl: env.rpcUrl,
  });
  const store: IndexerStore = env.databaseUrl
    ? new PostgresStore({ connectionString: env.databaseUrl })
    : new InMemoryStore();
  const storeKind: "memory" | "postgres" = env.databaseUrl
    ? "postgres"
    : "memory";
  const registry: RegistryResolver = createRegistryClient({
    baseUrl: env.registryUrl,
  });
  const external: ExternalResolver = createExternalResolver({
    path: env.externalAddressesPath,
    logger,
  });
  const indexer = createIndexer({
    publicClient: chain.publicClient,
    store,
    registry,
    external,
    network: chain.network,
    chainId: chain.chainId,
    startBlock: env.startBlock,
    maxBlockRange: env.maxBlockRange,
    confirmationDepth: env.confirmationDepth,
    intervalMs: env.indexIntervalSeconds * 1000,
    logger,
  });
  app = createApp({ chain, store, indexer, storeKind });
  serve({ fetch: app.fetch, port: env.port }, (info) => {
    process.stderr.write(
      `swarmwage-indexer v0.0.1 listening on http://localhost:${info.port} (network=${chain.network}, registry=${env.registryUrl}, store=${storeKind})\n`,
    );
  });

  // Run the loop alongside the HTTP server. Errors in the loop are logged
  // and swallowed; the process stays up to keep `/health` reachable.
  indexer.start().catch((err: Error) => {
    logger.error("indexer.fatal", { error: err.message });
  });

  const shutdown = () => {
    indexer.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

export { app };
