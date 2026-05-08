// Swarmwage Indexer — core scan loop
// License: BUSL-1.1
//
// One responsibility: turn the public USDC `Transfer` event log on the
// configured network into rows in `IndexerStore`, in monotonically
// increasing block order, idempotently across restarts.
//
// The indexer is read-only. It calls `getBlockNumber`, `getBlock`, and
// `getLogs` against the configured RPC endpoint and never sends a
// transaction.

import type { Address, Log } from "viem";

import type { PublicClientLike } from "./chain.js";
import type { RegistryResolver } from "./registry.js";
import type { IndexedTransaction, IndexerStore } from "./store.js";
import { TRANSFER_EVENT, USDC_ADDRESS } from "./usdc.js";
import type { IndexerNetwork } from "./env.js";

export interface IndexerLogger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

export interface IndexerDeps {
  publicClient: PublicClientLike;
  store: IndexerStore;
  registry: RegistryResolver;
  network: IndexerNetwork;
  chainId: number;
  /** Initial block to start indexing from when the store has no cursor. */
  startBlock?: bigint;
  /** Max blocks per `eth_getLogs` call. */
  maxBlockRange: number;
  /**
   * Number of blocks to lag behind the chain head before a block is treated
   * as final. Protects the `transactions` table from short reorgs on Base —
   * `latest - confirmationDepth` is the highest block the cursor will advance
   * to. Default 0 (legacy / test-friendly); production bootstrap sets 1+.
   */
  confirmationDepth?: number;
  /** Sleep between idle ticks, in ms. */
  intervalMs: number;
  logger?: IndexerLogger;
}

export interface IndexerHandle {
  /** Snapshot of the last cursor written to the store. */
  lastIndexedBlock(): bigint | null;
  /** Number of blocks behind the chain head as of the most recent tick. */
  lagBlocks(): number;
  /** Run a single tick. Returns the number of transactions written. */
  tickOnce(): Promise<number>;
  /** Start the loop. Resolves when `stop()` is called. */
  start(): Promise<void>;
  stop(): void;
}

const noopLogger: IndexerLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

export function createIndexer(deps: IndexerDeps): IndexerHandle {
  const {
    publicClient,
    store,
    registry,
    network,
    chainId,
    maxBlockRange,
    intervalMs,
  } = deps;
  const logger = deps.logger ?? noopLogger;
  const confirmationDepth = BigInt(deps.confirmationDepth ?? 0);
  const usdcAddress = USDC_ADDRESS[network];

  let cursor: bigint | null = null;
  let latestKnown: bigint = 0n;
  let stopRequested = false;

  async function ensureCursor(): Promise<bigint> {
    if (cursor !== null) return cursor;
    const persisted = await store.getLastIndexedBlock(chainId);
    if (persisted !== null) {
      cursor = persisted;
      return persisted;
    }
    if (deps.startBlock !== undefined) {
      const initial = deps.startBlock - 1n;
      cursor = initial;
      return initial;
    }
    // First boot, no explicit start block — anchor at the current head so we
    // begin capturing forward-going volume immediately. Operators that want
    // historical backfill set `START_BLOCK` explicitly.
    const head = (await publicClient.getBlockNumber()) as bigint;
    cursor = head;
    return head;
  }

  async function processRange(fromBlock: bigint, toBlock: bigint): Promise<number> {
    const logs = (await publicClient.getLogs({
      address: usdcAddress,
      event: TRANSFER_EVENT,
      fromBlock,
      toBlock,
    })) as TransferLog[];

    if (logs.length === 0) return 0;

    // Resolve recipient addresses against the registry. Cache hits in the
    // resolver collapse repeated `to` addresses within the batch.
    const uniqueRecipients = Array.from(
      new Set(logs.map((l) => (l.args.to ?? "").toLowerCase())),
    ).filter((a) => a.length > 0);
    const recipientToAgent = new Map<string, string | null>();
    await Promise.all(
      uniqueRecipients.map(async (addr) => {
        const agentId = await registry.resolveAgentId(addr);
        recipientToAgent.set(addr, agentId);
      }),
    );

    // Group logs by block to fetch each block's timestamp once.
    const blockNumbers = Array.from(new Set(logs.map((l) => l.blockNumber)));
    const blockTs = new Map<bigint, number>();
    await Promise.all(
      blockNumbers.map(async (bn) => {
        try {
          const b = await publicClient.getBlock({ blockNumber: bn });
          blockTs.set(bn, Number(b.timestamp));
        } catch {
          blockTs.set(bn, Math.floor(Date.now() / 1000));
        }
      }),
    );

    const rows: IndexedTransaction[] = logs
      .map((log): IndexedTransaction | null => {
        const from = log.args.from;
        const to = log.args.to;
        const value = log.args.value;
        if (!from || !to || value === undefined) return null;
        const recipientKey = to.toLowerCase();
        return {
          chain_id: chainId,
          block_number: log.blockNumber,
          log_index: log.logIndex,
          tx_hash: log.transactionHash,
          from_address: from,
          to_address: to,
          recipient_agent_id: recipientToAgent.get(recipientKey) ?? null,
          value_usdc_atomic: value,
          ts: blockTs.get(log.blockNumber) ?? Math.floor(Date.now() / 1000),
        };
      })
      .filter((row): row is IndexedTransaction => row !== null);

    if (rows.length > 0) {
      await store.upsertTransactions(rows);
    }
    return rows.length;
  }

  async function tickOnce(): Promise<number> {
    const startCursor = await ensureCursor();
    let from = startCursor + 1n;
    let written = 0;

    let latest: bigint;
    try {
      latest = await publicClient.getBlockNumber();
    } catch (err) {
      logger.warn("indexer.tick.getBlockNumber_failed", {
        error: (err as Error).message,
      });
      return 0;
    }
    latestKnown = latest;

    // The cursor is only allowed to advance to `latest - confirmationDepth`.
    // Blocks newer than that are still subject to reorg on Base; indexing
    // them would poison `transactions` with rows that reference orphaned
    // blocks. `safeLatest` is clamped to 0 when the chain is younger than
    // the configured depth (only relevant on local devnets).
    const safeLatest =
      latest > confirmationDepth ? latest - confirmationDepth : 0n;

    if (from > safeLatest) {
      logger.debug("indexer.tick.idle", {
        cursor: startCursor.toString(),
        latest: latest.toString(),
        safe_latest: safeLatest.toString(),
      });
      return 0;
    }

    const rangeSize = BigInt(maxBlockRange);

    // Catch-up loop: if we are far behind the head, process consecutive
    // batches without sleeping until we are within one batch of the tip.
    while (from <= safeLatest) {
      const to =
        from + rangeSize - 1n > safeLatest ? safeLatest : from + rangeSize - 1n;
      try {
        const n = await processRange(from, to);
        written += n;
        cursor = to;
        await store.setLastIndexedBlock(chainId, to);
        logger.debug("indexer.tick.range_written", {
          from: from.toString(),
          to: to.toString(),
          rows: n,
        });
      } catch (err) {
        logger.error("indexer.tick.range_failed", {
          from: from.toString(),
          to: to.toString(),
          error: (err as Error).message,
        });
        // Stop the catch-up loop on failure; the next tick will retry from
        // the same cursor, preserving idempotency.
        break;
      }
      from = to + 1n;
    }

    return written;
  }

  async function start(): Promise<void> {
    stopRequested = false;
    logger.info("indexer.start", {
      network,
      chainId,
      usdc: usdcAddress,
      intervalMs,
      maxBlockRange,
    });
    // Initialise cursor up front so `/health` reports a value before the
    // first tick completes.
    await ensureCursor();
    while (!stopRequested) {
      try {
        await tickOnce();
      } catch (err) {
        logger.error("indexer.tick.unexpected_error", {
          error: (err as Error).message,
        });
      }
      if (stopRequested) break;
      await sleep(intervalMs);
    }
    logger.info("indexer.stop", {});
  }

  function stop(): void {
    stopRequested = true;
  }

  return {
    lastIndexedBlock: () => cursor,
    lagBlocks: () => {
      if (cursor === null) return 0;
      const lag = latestKnown - cursor;
      return lag > 0n ? Number(lag) : 0;
    },
    tickOnce,
    start,
    stop,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/**
 * Shape of a viem `Log` decoded with `event: TRANSFER_EVENT`. We narrow it
 * here so the indexer body does not have to repeat the cast at every use.
 */
type TransferLog = Log<bigint, number, false> & {
  args: {
    from?: Address;
    to?: Address;
    value?: bigint;
  };
};
