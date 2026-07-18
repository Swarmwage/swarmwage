// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Swarmwage
//
// Fund-flow indexer — polls Base mainnet for USDC Transfer logs and keeps a
// ring buffer of the transfers that touch any of the 12 tournament wallets.
//
// Why in-process (not viem, not a separate service):
//   - The leaderboard image does a standalone `npm install` of this package
//     only; adding viem bloats the 256MB container. Plain fetch + JSON-RPC is
//     enough for a single fixed event signature.
//   - Keeping it here means one container owns the whole observability surface
//     (flow + activity + reasoning), simplest to deploy.
//
// USDC on Base (FiatTokenV2.2): 0x833589fcd6edb6e08f4c7c32d4f71b54bda02913
// Transfer(address indexed from, address indexed to, uint256 value)
//   topic0 = keccak256("Transfer(address,address,uint256)")
//          = 0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef

import { ALL_ADDRESSES, metaByAddress, type AgentMeta } from './roster.js';

const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const TRANSFER_TOPIC =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

const RPC_URL = process.env.BASE_RPC_URL ?? 'https://base-rpc.publicnode.com';
const POLL_MS = Number(process.env.FLOW_POLL_MS ?? 15_000);
/** Blocks scanned per poll. Safe to keep large because the getLogs queries are
 *  address-filtered server-side (see CLUSTER_TOPICS), so they return only
 *  cluster transfers — never the full USDC firehose. */
const MAX_BLOCK_SPAN = Number(process.env.FLOW_MAX_BLOCK_SPAN ?? 3000);
/** First-poll lookback so settlements that already happened show up on boot. */
const INITIAL_LOOKBACK = Number(process.env.FLOW_INITIAL_LOOKBACK ?? 9000);
const RING_SIZE = Number(process.env.FLOW_RING_SIZE ?? 500);

export interface FlowEvent {
  tx_hash: string;
  block_number: number;
  ts: number; // ms epoch, best-effort (block time fetched lazily)
  from: string;
  to: string;
  from_label: string;
  to_label: string;
  /** 'buyer'->'internal' = external demand entering; 'internal'->'internal' = sub-hire/recirculation. */
  edge_kind: 'demand' | 'recirculation' | 'mixed' | 'unknown';
  usdc: string; // decimal string
  usdc_atomic: string;
}

const ALL_SET = new Set(ALL_ADDRESSES);
// Padded 32-byte topic form of each tournament wallet, for SERVER-SIDE
// getLogs filtering. Without this the indexer fetched EVERY USDC Transfer on
// Base (>20000 logs per 800-block window → the node rejects the query with
// "exceeds max results 20000"), so the ring never filled and the UI showed
// no payments / no volume.
const CLUSTER_TOPICS = ALL_ADDRESSES.map(
  (a) => '0x' + a.replace(/^0x/, '').toLowerCase().padStart(64, '0'),
);
let ring: FlowEvent[] = [];
let lastBlock = 0;
let started = false;
let lastError: string | null = null;
const blockTsCache = new Map<number, number>();

function addressFromTopic(topic: string): string {
  // indexed address is right-aligned in a 32-byte topic
  return ('0x' + topic.slice(-40)).toLowerCase();
}

function atomicToDecimal(atomic: bigint): string {
  // USDC has 6 decimals
  const s = atomic.toString().padStart(7, '0');
  const whole = s.slice(0, -6);
  const frac = s.slice(-6).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
}

function classifyEdge(from?: AgentMeta, to?: AgentMeta): FlowEvent['edge_kind'] {
  if (!from && !to) return 'unknown';
  if (from?.kind === 'buyer' && to?.kind === 'internal') return 'demand';
  if (from?.kind === 'internal' && to?.kind === 'internal') return 'recirculation';
  return 'mixed';
}

async function rpc<T = unknown>(method: string, params: unknown[]): Promise<T> {
  const res = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`rpc ${method} → ${res.status}`);
  const j = (await res.json()) as { result?: T; error?: { message: string } };
  if (j.error) throw new Error(`rpc ${method}: ${j.error.message}`);
  return j.result as T;
}

async function blockTimestamp(blockNumber: number): Promise<number> {
  const cached = blockTsCache.get(blockNumber);
  if (cached) return cached;
  try {
    const blk = await rpc<{ timestamp: string } | null>('eth_getBlockByNumber', [
      '0x' + blockNumber.toString(16),
      false,
    ]);
    const ts = blk?.timestamp ? parseInt(blk.timestamp, 16) * 1000 : Date.now();
    blockTsCache.set(blockNumber, ts);
    // keep the cache bounded
    if (blockTsCache.size > 2000) {
      const firstKey = blockTsCache.keys().next().value;
      if (firstKey !== undefined) blockTsCache.delete(firstKey);
    }
    return ts;
  } catch {
    return Date.now();
  }
}

interface RawLog {
  transactionHash: string;
  blockNumber: string;
  logIndex: string;
  topics: string[];
  data: string;
}

async function poll(): Promise<void> {
  const headHex = await rpc<string>('eth_blockNumber', []);
  const head = parseInt(headHex, 16);
  if (!Number.isFinite(head)) return;

  if (lastBlock === 0) {
    // first poll — look back far enough to catch settlements already on-chain
    lastBlock = Math.max(0, head - INITIAL_LOOKBACK);
  }
  if (head <= lastBlock) return;

  const from = lastBlock + 1;
  const to = Math.min(head, from + MAX_BLOCK_SPAN - 1);

  // Two address-filtered queries — transfers FROM a cluster wallet and TO a
  // cluster wallet — so the node only returns tournament-relevant logs.
  const range = { fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16) };
  const [logsFrom, logsTo] = await Promise.all([
    rpc<RawLog[]>('eth_getLogs', [{ address: USDC, topics: [TRANSFER_TOPIC, CLUSTER_TOPICS], ...range }]),
    rpc<RawLog[]>('eth_getLogs', [{ address: USDC, topics: [TRANSFER_TOPIC, null, CLUSTER_TOPICS], ...range }]),
  ]);
  // Agent→agent transfers match both queries; dedupe by tx + log index.
  const seen = new Set<string>();
  const logs: RawLog[] = [];
  for (const log of [...logsFrom, ...logsTo]) {
    const key = `${log.transactionHash}:${log.logIndex}`;
    if (seen.has(key)) continue;
    seen.add(key);
    logs.push(log);
  }

  const fresh: FlowEvent[] = [];
  for (const log of logs) {
    if (!log.topics || log.topics.length < 3) continue;
    const fromAddr = addressFromTopic(log.topics[1]);
    const toAddr = addressFromTopic(log.topics[2]);
    // Only keep transfers that involve at least one tournament wallet.
    if (!ALL_SET.has(fromAddr) && !ALL_SET.has(toAddr)) continue;

    let atomic: bigint;
    try {
      atomic = BigInt(log.data);
    } catch {
      continue;
    }
    const blockNumber = parseInt(log.blockNumber, 16);
    const fromMeta = metaByAddress(fromAddr);
    const toMeta = metaByAddress(toAddr);
    fresh.push({
      tx_hash: log.transactionHash,
      block_number: blockNumber,
      ts: 0, // filled below
      from: fromAddr,
      to: toAddr,
      from_label: fromMeta?.label ?? shortAddr(fromAddr),
      to_label: toMeta?.label ?? shortAddr(toAddr),
      edge_kind: classifyEdge(fromMeta, toMeta),
      usdc: atomicToDecimal(atomic),
      usdc_atomic: atomic.toString(),
    });
  }

  // Resolve block timestamps (deduped) for the fresh batch only.
  const blocks = Array.from(new Set(fresh.map((f) => f.block_number)));
  const tsByBlock = new Map<number, number>();
  for (const b of blocks) tsByBlock.set(b, await blockTimestamp(b));
  for (const f of fresh) f.ts = tsByBlock.get(f.block_number) ?? Date.now();

  if (fresh.length > 0) {
    ring = ring.concat(fresh).slice(-RING_SIZE);
  }
  lastBlock = to;
  lastError = null;
}

function shortAddr(a: string): string {
  return a ? a.slice(0, 6) + '…' + a.slice(-4) : '?';
}

export function startFlowIndexer(): void {
  if (started) return;
  started = true;
  const loop = async () => {
    try {
      await poll();
    } catch (e) {
      lastError = String(e);
      console.error('[flow-indexer]', lastError);
    } finally {
      setTimeout(loop, POLL_MS);
    }
  };
  loop();
  console.log(`[flow-indexer] polling ${RPC_URL} every ${POLL_MS}ms`);
}

export interface FlowSnapshot {
  as_of: string;
  rpc: string;
  last_block: number;
  last_error: string | null;
  /** Per-edge aggregate volume (from_label -> to_label) for the Sankey/graph view. */
  edges: Array<{ from: string; to: string; from_label: string; to_label: string; usdc: string; count: number; edge_kind: FlowEvent['edge_kind'] }>;
  events: FlowEvent[];
}

export function flowSnapshot(limit = 60): FlowSnapshot {
  const recent = ring.slice(-limit).reverse();
  // Aggregate edges across the full ring for the flow graph.
  const edgeMap = new Map<string, { from: string; to: string; from_label: string; to_label: string; atomic: bigint; count: number; edge_kind: FlowEvent['edge_kind'] }>();
  for (const e of ring) {
    const key = `${e.from}->${e.to}`;
    const prev = edgeMap.get(key);
    let atomic: bigint;
    try { atomic = BigInt(e.usdc_atomic); } catch { atomic = 0n; }
    if (prev) {
      prev.atomic += atomic;
      prev.count += 1;
    } else {
      edgeMap.set(key, { from: e.from, to: e.to, from_label: e.from_label, to_label: e.to_label, atomic, count: 1, edge_kind: e.edge_kind });
    }
  }
  const edges = Array.from(edgeMap.values())
    .map((x) => ({
      from: x.from,
      to: x.to,
      from_label: x.from_label,
      to_label: x.to_label,
      usdc: atomicToDecimal(x.atomic),
      count: x.count,
      edge_kind: x.edge_kind,
    }))
    .sort((a, b) => Number(b.usdc) - Number(a.usdc));

  return {
    as_of: new Date().toISOString(),
    rpc: RPC_URL,
    last_block: lastBlock,
    last_error: lastError,
    edges,
    events: recent,
  };
}
