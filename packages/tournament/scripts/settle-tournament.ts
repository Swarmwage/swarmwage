// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Swarmwage
//
// Settle the tournament at T+48h.
//
//   1. Snapshot every agent wallet's USDC balance.
//   2. Rank, declare winner.
//   3. Write `.tournament-secrets/settlement-<ts>.json` (private full record).
//   4. Write `packages/tournament/leaderboard/public/settlement-final.json` (public).
//   5. Optionally drain each wallet's USDC back to OPS_WALLET via
//      `transferWithAuthorization`. The agent wallet only SIGNS (no gas);
//      the ops wallet executes the on-chain tx and pays gas. Agent
//      wallets never hold or spend a single wei of ETH.
//
// Environment:
//   OPS_WALLET_PRIVATE_KEY   destination + gas payer for the drain (required when DRAIN=1)
//   OPS_WALLET_ADDRESS       fallback destination (read-only mode without drain)
//   WALLETS_PATH             default ../.tournament-secrets/wallets.json
//   PUBLIC_PATH              default ../.tournament-secrets/wallets.public.json
//   LEADERBOARD_PUBLIC_DIR   default ../leaderboard/public
//   DRAIN                    if "1", sign + submit transferWithAuthorization
//   DRY_RUN                  if "1", do not transact

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  createPublicClient,
  createWalletClient,
  http,
  parseSignature,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';

const OPS_KEY = process.env.OPS_WALLET_PRIVATE_KEY as Hex | undefined;
const OPS_ADDR_OVERRIDE = (process.env.OPS_WALLET_ADDRESS ?? '').toLowerCase() as Address;
const WALLETS_PATH = process.env.WALLETS_PATH ?? resolve(process.cwd(), '../../.tournament-secrets/wallets.json');
const PUBLIC_PATH = process.env.PUBLIC_PATH ?? resolve(process.cwd(), '../../.tournament-secrets/wallets.public.json');
const LEADERBOARD_DIR = process.env.LEADERBOARD_PUBLIC_DIR ?? resolve(process.cwd(), '../leaderboard/public');
const DRAIN = process.env.DRAIN === '1';
const DRY_RUN = process.env.DRY_RUN === '1';
const RPC = process.env.BASE_RPC_URL ?? 'https://mainnet.base.org';

const USDC_BASE: Address = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';

if (DRAIN && !OPS_KEY) {
  console.error('DRAIN=1 requires OPS_WALLET_PRIVATE_KEY (the ops wallet pays gas for each transferWithAuthorization).');
  process.exit(1);
}

const opsAccount = OPS_KEY ? privateKeyToAccount(OPS_KEY) : null;
const opsAddress = (opsAccount?.address ?? OPS_ADDR_OVERRIDE) as Address;
if (!opsAddress) {
  console.error('No ops address (set OPS_WALLET_PRIVATE_KEY or OPS_WALLET_ADDRESS).');
  process.exit(1);
}

const wallets = JSON.parse(readFileSync(WALLETS_PATH, 'utf-8')) as Record<string, Hex>;
const publicMap = JSON.parse(readFileSync(PUBLIC_PATH, 'utf-8')) as {
  wallets: Array<{ agent_id: string; address: Address }>;
};

const publicClient = createPublicClient({ chain: base, transport: http(RPC) });
const opsWallet = opsAccount
  ? createWalletClient({ account: opsAccount, chain: base, transport: http(RPC) })
  : null;

// USDC FiatTokenV2.2 EIP-712 domain on Base mainnet
const usdcDomain = {
  name: 'USD Coin',
  version: '2',
  chainId: 8453,
  verifyingContract: USDC_BASE,
} as const;

const transferAuthTypes = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const;

const usdcAbi = [
  {
    name: 'balanceOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'transferWithAuthorization',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' },
      { name: 'validBefore', type: 'uint256' },
      { name: 'nonce', type: 'bytes32' },
      { name: 'v', type: 'uint8' },
      { name: 'r', type: 'bytes32' },
      { name: 's', type: 'bytes32' },
    ],
    outputs: [],
  },
] as const;

async function snapshot() {
  const rows: Array<{
    agent_id: string;
    address: Address;
    usdc: number;
    usdc_raw: string;
    eth_wei: string;
  }> = [];
  for (const { agent_id, address } of publicMap.wallets) {
    const usdc = (await publicClient.readContract({
      address: USDC_BASE,
      abi: usdcAbi,
      functionName: 'balanceOf',
      args: [address],
    })) as bigint;
    const eth = await publicClient.getBalance({ address });
    rows.push({
      agent_id,
      address,
      usdc_raw: usdc.toString(),
      usdc: Number(usdc) / 1e6,
      eth_wei: eth.toString(),
    });
  }
  rows.sort((a, b) => b.usdc - a.usdc);
  return rows;
}

function randomBytes32(): Hex {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return ('0x' + Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('')) as Hex;
}

/**
 * Drain `agentId` to ops wallet via EIP-3009. The agent wallet only signs;
 * the ops wallet submits and pays gas. Agent wallet never touches ETH.
 */
async function drainOne(agentId: string, address: Address): Promise<Hex | null> {
  if (!opsWallet) throw new Error('drain requested without ops wallet');
  const pk = wallets[agentId];
  if (!pk) {
    console.warn(`No key for ${agentId} — skipping drain`);
    return null;
  }
  const bal = (await publicClient.readContract({
    address: USDC_BASE,
    abi: usdcAbi,
    functionName: 'balanceOf',
    args: [address],
  })) as bigint;
  if (bal === 0n) {
    console.log(`  ${agentId}: 0 USDC — skip`);
    return null;
  }
  if (DRY_RUN) {
    console.log(`  ${agentId}: would drain ${bal.toString()} atomic via EIP-3009 (ops pays gas)`);
    return null;
  }

  const agentAccount = privateKeyToAccount(pk);
  const now = Math.floor(Date.now() / 1000);
  const message = {
    from: address,
    to: opsAddress,
    value: bal,
    validAfter: BigInt(0),
    validBefore: BigInt(now + 3600), // 1h window
    nonce: randomBytes32(),
  } as const;

  const signature = await agentAccount.signTypedData({
    domain: usdcDomain,
    types: transferAuthTypes,
    primaryType: 'TransferWithAuthorization',
    message,
  });
  const { v, r, s } = parseSignature(signature);

  const txHash = await opsWallet.writeContract({
    address: USDC_BASE,
    abi: usdcAbi,
    functionName: 'transferWithAuthorization',
    args: [
      message.from,
      message.to,
      message.value,
      message.validAfter,
      message.validBefore,
      message.nonce,
      Number(v ?? 27),
      r,
      s,
    ],
  });
  console.log(`  ${agentId}: drained ${bal.toString()} atomic via ${txHash} (ops paid gas)`);
  return txHash;
}

(async () => {
  console.log('Snapshotting balances...');
  const rows = await snapshot();
  const ts = new Date().toISOString();

  const settlement = {
    ts,
    ops_wallet: opsAddress,
    drain_executed: DRAIN && !DRY_RUN,
    winner: rows[0]?.agent_id ?? null,
    standings: rows.map((r, idx) => ({ rank: idx + 1, ...r })),
  };

  if (!existsSync(LEADERBOARD_DIR)) mkdirSync(LEADERBOARD_DIR, { recursive: true });

  const privateOut = resolve(process.cwd(), `../../.tournament-secrets/settlement-${ts.replace(/[:.]/g, '-')}.json`);
  const publicOut = resolve(LEADERBOARD_DIR, 'settlement-final.json');

  writeFileSync(privateOut, JSON.stringify(settlement, null, 2));
  writeFileSync(publicOut, JSON.stringify({ ...settlement, ops_wallet: undefined }, null, 2));
  console.log(`Settlement written: ${privateOut}, ${publicOut}`);

  console.log('');
  console.log('=== FINAL STANDINGS ===');
  for (const r of settlement.standings) {
    console.log(`  ${r.rank}. ${r.agent_id}  ${r.usdc.toFixed(4)} USDC  ${r.address}`);
  }
  console.log('');

  if (DRAIN) {
    console.log(`Draining all wallets to ${opsAddress} via EIP-3009 (ops wallet pays gas)...`);
    for (const r of rows) {
      await drainOne(r.agent_id, r.address);
      await new Promise((res) => setTimeout(res, 1000));
    }
  }
})().catch((e) => {
  console.error('Settlement failed:', e);
  process.exit(1);
});
