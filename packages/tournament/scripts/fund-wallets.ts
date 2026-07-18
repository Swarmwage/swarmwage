// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Swarmwage
//
// Fund each agent wallet with the starting USDC budget. Funds are sourced
// from OPS_WALLET_PRIVATE_KEY.
//
// **No ETH is sent to agent wallets.** Agents pay zero gas during the
// tournament — all USDC movement happens through Swarmwage Facilitator's
// gas-relay (buyer hires) or via ops-wallet-paid `transferWithAuthorization`
// at settle time. This is the whole point of the "zero-custody, zero-gas"
// agent design. If you find yourself reaching for ETH on an agent wallet,
// you've taken a wrong turn.
//
// The script is idempotent: it skips agents whose wallets already hold
// ≥ the target USDC.
//
// Environment:
//   OPS_WALLET_PRIVATE_KEY   funding wallet (must have N*5 USDC + buyer*10 USDC + enough ETH)
//   PER_AGENT_USDC           default "5"  (applied to wallets with id `agent_*`)
//   PER_BUYER_USDC           default "10" (applied to wallets with id `buyer_*`)
//   WALLETS_PUBLIC_PATH      default ../.tournament-secrets/wallets.public.json
//   BASE_RPC_URL             default https://mainnet.base.org
//   DRY_RUN                  if "1", print plan but send no transactions
//   FUND_ETH_DEBUG           if "1", also send ETH_PER_AGENT_WEI to each wallet
//                            (debug only; breaks the "agents never touch ETH"
//                             invariant — do NOT use during a real tournament)
//   ETH_PER_AGENT_WEI        only honored if FUND_ETH_DEBUG=1 (default 0)

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  createPublicClient,
  createWalletClient,
  http,
  parseUnits,
  encodeFunctionData,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';

const OPS_KEY = process.env.OPS_WALLET_PRIVATE_KEY as Hex | undefined;
if (!OPS_KEY) {
  console.error('OPS_WALLET_PRIVATE_KEY not set — refusing to run.');
  process.exit(1);
}

const PER_AGENT_USDC = process.env.PER_AGENT_USDC ?? '5';
const PER_BUYER_USDC = process.env.PER_BUYER_USDC ?? '10';
const FUND_ETH_DEBUG = process.env.FUND_ETH_DEBUG === '1';
const ETH_PER_AGENT_WEI = FUND_ETH_DEBUG
  ? BigInt(process.env.ETH_PER_AGENT_WEI ?? '1500000000000000')
  : 0n;
const DRY_RUN = process.env.DRY_RUN === '1';
const PUBLIC_PATH = process.env.WALLETS_PUBLIC_PATH ?? resolve(process.cwd(), '../../.tournament-secrets/wallets.public.json');
const RPC = process.env.BASE_RPC_URL ?? 'https://mainnet.base.org';

const USDC_BASE: Address = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const agentTargetAtomic = parseUnits(PER_AGENT_USDC, 6);
const buyerTargetAtomic = parseUnits(PER_BUYER_USDC, 6);

function targetFor(agentId: string): bigint {
  return agentId.startsWith('buyer_') ? buyerTargetAtomic : agentTargetAtomic;
}

const opsAccount = privateKeyToAccount(OPS_KEY);
const publicClient = createPublicClient({ chain: base, transport: http(RPC) });
const wallet = createWalletClient({ account: opsAccount, chain: base, transport: http(RPC) });

const usdcAbi = [
  {
    name: 'balanceOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'transfer',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const;

type AgentPub = { agent_id: string; address: Address };
const { wallets }: { wallets: AgentPub[] } = JSON.parse(readFileSync(PUBLIC_PATH, 'utf-8'));

console.log(`Funding ${wallets.length} agents from ${opsAccount.address}`);
console.log(`  per-agent USDC: ${PER_AGENT_USDC} (${agentTargetAtomic.toString()} atomic) — applied to agent_* ids`);
console.log(`  per-buyer USDC: ${PER_BUYER_USDC} (${buyerTargetAtomic.toString()} atomic) — applied to buyer_* ids`);
if (FUND_ETH_DEBUG) {
  console.log(`  per-agent ETH:  ${ETH_PER_AGENT_WEI.toString()} wei  (FUND_ETH_DEBUG=1)`);
} else {
  console.log('  per-agent ETH:  0  (agents do not need gas — facilitator pays)');
}
console.log(`  dry-run:        ${DRY_RUN}`);
console.log('');

async function ensureUsdc(to: Address, target: bigint) {
  const bal = (await publicClient.readContract({
    address: USDC_BASE,
    abi: usdcAbi,
    functionName: 'balanceOf',
    args: [to],
  })) as bigint;
  if (bal >= target) {
    console.log(`  USDC ${to}: already has ${bal.toString()} atomic (>= target ${target}) — skip`);
    return null;
  }
  const need = target - bal;
  if (DRY_RUN) {
    console.log(`  USDC ${to}: would send ${need.toString()} atomic`);
    return null;
  }
  const hash = await wallet.writeContract({
    address: USDC_BASE,
    abi: usdcAbi,
    functionName: 'transfer',
    args: [to, need],
  });
  console.log(`  USDC ${to}: tx ${hash} — waiting for confirmation…`);
  const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
  console.log(`  USDC ${to}: confirmed in block ${receipt.blockNumber} (${receipt.status})`);
  return hash;
}

async function ensureEth(to: Address) {
  const bal = await publicClient.getBalance({ address: to });
  if (bal >= ETH_PER_AGENT_WEI) {
    console.log(`  ETH  ${to}: already has ${bal.toString()} wei — skip`);
    return null;
  }
  const need = ETH_PER_AGENT_WEI - bal;
  if (DRY_RUN) {
    console.log(`  ETH  ${to}: would send ${need.toString()} wei`);
    return null;
  }
  const hash = await wallet.sendTransaction({ to, value: need });
  console.log(`  ETH  ${to}: tx ${hash}`);
  return hash;
}

const DELAY_MS = Number(process.env.FUND_DELAY_MS ?? '700');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

(async () => {
  for (const w of wallets) {
    const target = targetFor(w.agent_id);
    const targetLabel = w.agent_id.startsWith('buyer_') ? PER_BUYER_USDC : PER_AGENT_USDC;
    console.log(`Agent ${w.agent_id} (${w.address}) — target $${targetLabel}`);
    if (FUND_ETH_DEBUG) await ensureEth(w.address);
    await ensureUsdc(w.address, target);
    if (DELAY_MS > 0) await sleep(DELAY_MS);
  }
  console.log('');
  console.log(DRY_RUN ? 'Dry-run complete — no transactions sent.' : 'Funding complete.');
})().catch((e) => {
  console.error('Funding failed:', e);
  process.exit(1);
});
