// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Swarmwage
//
// One-shot: fund N dry-run wallets via EIP-3009 transferWithAuthorization.
//
// Pattern (the canonical Swarmwage one):
//   - PAYER wallet has USDC, NO ETH. Signs the authorization.
//   - RELAYER wallet has ETH, NO USDC. Submits the tx, pays gas.
//   - The dry-run wallets receive exactly the requested USDC, no ETH.
//
// All keys read from env vars; no key value is ever printed to stdout.
//
// Env:
//   PAYER_PRIVATE_KEY        wallet that holds the USDC to disperse
//   RELAYER_PRIVATE_KEY      wallet that holds ETH and submits the tx (facilitator gas wallet)
//   N                        default 2
//   USDC_PER_WALLET          default "0.10"
//   OUT_DIR                  default ../../.tournament-secrets/dry-run

import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  createPublicClient,
  createWalletClient,
  http,
  parseSignature,
  parseUnits,
  type Address,
  type Hex,
} from 'viem';
import { base } from 'viem/chains';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';

const PAYER_KEY = process.env.PAYER_PRIVATE_KEY as Hex | undefined;
const RELAYER_KEY = process.env.RELAYER_PRIVATE_KEY as Hex | undefined;
if (!PAYER_KEY || !RELAYER_KEY) {
  console.error('PAYER_PRIVATE_KEY and RELAYER_PRIVATE_KEY required');
  process.exit(1);
}
const N = Number(process.env.N ?? 2);
const USDC_PER_WALLET = process.env.USDC_PER_WALLET ?? '0.10';
const OUT_DIR = process.env.OUT_DIR ?? resolve(process.cwd(), '../../.tournament-secrets/dry-run');
const RPC = process.env.BASE_RPC_URL ?? 'https://mainnet.base.org';

const USDC_BASE: Address = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const valueAtomic = parseUnits(USDC_PER_WALLET, 6);

const payer = privateKeyToAccount(PAYER_KEY);
const relayer = privateKeyToAccount(RELAYER_KEY);

const pub = createPublicClient({ chain: base, transport: http(RPC) });
const relayerWallet = createWalletClient({ account: relayer, chain: base, transport: http(RPC) });

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
    inputs: [{ name: 'a', type: 'address' }],
    outputs: [{ type: 'uint256' }],
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

function rand32(): Hex {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return ('0x' + Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join('')) as Hex;
}

function pad(n: number, w = 2) {
  return String(n).padStart(w, '0');
}

(async () => {
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

  console.log(`Payer:   ${payer.address}`);
  console.log(`Relayer: ${relayer.address}`);
  console.log('');

  // Pre-flight balances
  const payerUsdc = (await pub.readContract({
    address: USDC_BASE,
    abi: usdcAbi,
    functionName: 'balanceOf',
    args: [payer.address],
  })) as bigint;
  const relayerEth = await pub.getBalance({ address: relayer.address });
  const needUsdc = valueAtomic * BigInt(N);
  console.log(`Payer USDC:    ${(Number(payerUsdc) / 1e6).toFixed(4)}  (need ${(Number(needUsdc) / 1e6).toFixed(4)})`);
  console.log(`Relayer ETH:   ${(Number(relayerEth) / 1e18).toFixed(6)}`);
  if (payerUsdc < needUsdc) {
    console.error('Payer USDC insufficient.');
    process.exit(1);
  }
  if (relayerEth < 50_000_000_000_000n) {
    console.warn(`Warning: relayer ETH < 0.00005 — may not cover ${N} txs of ~0.00002 ETH each.`);
  }
  console.log('');

  // Generate N dry-run wallets
  const wallets: Record<string, Hex> = {};
  const publicWallets: Array<{ agent_id: string; address: Address }> = [];
  for (let i = 1; i <= N; i++) {
    const id = `agent_${pad(i)}`;
    const pk = generatePrivateKey();
    const acct = privateKeyToAccount(pk);
    wallets[id] = pk;
    publicWallets.push({ agent_id: id, address: acct.address });
  }
  writeFileSync(resolve(OUT_DIR, 'wallets.json'), JSON.stringify(wallets, null, 2), { mode: 0o600 });
  writeFileSync(
    resolve(OUT_DIR, 'wallets.public.json'),
    JSON.stringify({ generated_at: new Date().toISOString(), count: N, wallets: publicWallets }, null, 2),
  );
  writeFileSync(
    resolve(OUT_DIR, 'caps.json'),
    JSON.stringify({ default: { maxSignsPerDay: 100, maxValueUsdcPerDay: '1000000' } }, null, 2),
  );
  console.log(`Generated ${N} wallets at ${OUT_DIR}`);
  for (const w of publicWallets) console.log(`  ${w.agent_id}  ${w.address}`);
  console.log('');

  // For each, sign + relay
  for (const { agent_id, address } of publicWallets) {
    const now = Math.floor(Date.now() / 1000);
    const message = {
      from: payer.address,
      to: address,
      value: valueAtomic,
      validAfter: BigInt(0),
      validBefore: BigInt(now + 1800),
      nonce: rand32(),
    } as const;
    const signature = await payer.signTypedData({
      domain: usdcDomain,
      types: transferAuthTypes,
      primaryType: 'TransferWithAuthorization',
      message,
    });
    const { v, r, s } = parseSignature(signature);
    console.log(`→ ${agent_id}  signed authorization for ${(Number(valueAtomic) / 1e6).toFixed(4)} USDC`);
    const txHash = await relayerWallet.writeContract({
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
    console.log(`  tx ${txHash}`);
    // Wait for confirmation
    const receipt = await pub.waitForTransactionReceipt({ hash: txHash, timeout: 60_000 });
    console.log(`  confirmed in block ${receipt.blockNumber}, gas used ${receipt.gasUsed}`);
  }

  // Post-flight balances
  console.log('');
  console.log('Final balances:');
  for (const { agent_id, address } of publicWallets) {
    const bal = (await pub.readContract({
      address: USDC_BASE,
      abi: usdcAbi,
      functionName: 'balanceOf',
      args: [address],
    })) as bigint;
    const eth = await pub.getBalance({ address });
    console.log(`  ${agent_id}  ${address}  USDC=${(Number(bal) / 1e6).toFixed(4)}  ETH=${(Number(eth) / 1e18).toFixed(6)}`);
  }
})().catch((e) => {
  console.error('Funding failed:', e);
  process.exit(1);
});
