// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Swarmwage
//
// Post-tournament recovery: sweep every agent/buyer wallet's USDC back to a
// destination wallet, using the public Swarmwage Facilitator /settle endpoint
// to pay gas. Each agent wallet only SIGNS an EIP-3009
// transferWithAuthorization; the facilitator submits the tx and pays ETH gas.
// Agent wallets never hold or spend a single wei of ETH.
//
// This is the HTTP-relay variant of settle-tournament.ts's DRAIN mode: it does
// NOT require the ops/relayer private key — only the agent keys (to sign) and
// the public facilitator endpoint (to broadcast).
//
// Env:
//   WALLETS_PATH   map agent_id -> private key   (required)
//   DEST           destination address for all swept USDC   (required for settle)
//   MODE           "verify" (dry-run, read-only, default) | "settle" (real broadcast)
//   FACILITATOR    default https://facilitator.swarmwage.com
//   BASE_RPC_URL   default https://mainnet.base.org
//   DELAY_MS       default 2500 (between requests; settle IP limit is 20/min)
//
// No key value is ever printed.

import { readFileSync } from 'node:fs';
import {
  createPublicClient,
  http,
  parseSignature,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';

const WALLETS_PATH = process.env.WALLETS_PATH;
const DEST = (process.env.DEST ?? '') as Address;
const MODE = (process.env.MODE ?? 'verify').toLowerCase();
const FACILITATOR = process.env.FACILITATOR ?? 'https://facilitator.swarmwage.com';
const RPC = process.env.BASE_RPC_URL ?? 'https://mainnet.base.org';
const DELAY_MS = Number(process.env.DELAY_MS ?? '2500');
// Cap the number of wallets actually swept this run (0 = no cap). Used to do a
// single-wallet test drain before sweeping the rest.
const LIMIT = Number(process.env.LIMIT ?? '0');

if (!WALLETS_PATH) {
  console.error('WALLETS_PATH required');
  process.exit(1);
}
if (MODE !== 'verify' && MODE !== 'settle') {
  console.error('MODE must be "verify" or "settle"');
  process.exit(1);
}
if (!/^0x[a-fA-F0-9]{40}$/.test(DEST)) {
  console.error('DEST must be a 0x-prefixed 40-hex address');
  process.exit(1);
}

const USDC_BASE: Address = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';

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
] as const;

function rand32(): Hex {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return ('0x' + Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join('')) as Hex;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const wallets = JSON.parse(readFileSync(WALLETS_PATH, 'utf-8')) as Record<string, Hex>;
const pub = createPublicClient({ chain: base, transport: http(RPC) });

async function readBal(addr: Address): Promise<bigint> {
  for (let i = 0; i < 6; i++) {
    try {
      return (await pub.readContract({
        address: USDC_BASE,
        abi: usdcAbi,
        functionName: 'balanceOf',
        args: [addr],
      })) as bigint;
    } catch {
      await sleep(1800 * (i + 1));
    }
  }
  throw new Error('rate-limited reading balance for ' + addr);
}

(async () => {
  console.log(`Mode:        ${MODE.toUpperCase()}${MODE === 'verify' ? ' (dry-run, no funds move)' : ' (REAL broadcast)'}`);
  console.log(`Destination: ${DEST}`);
  console.log(`Facilitator: ${FACILITATOR}`);
  console.log('');

  let okCount = 0;
  let totalSwept = 0n;
  const txs: Array<{ id: string; tx: string; usdc: number }> = [];

  for (const [id, pk] of Object.entries(wallets)) {
    const account = privateKeyToAccount(pk);
    const from = account.address;
    const bal = await readBal(from);
    await sleep(800);

    if (bal === 0n) {
      console.log(`  ${id.padEnd(10)} ${from}  0 USDC — skip`);
      continue;
    }

    const now = Math.floor(Date.now() / 1000);
    const message = {
      from,
      to: DEST,
      value: bal,
      validAfter: BigInt(0),
      validBefore: BigInt(now + 3600),
      nonce: rand32(),
    } as const;

    const signature = await account.signTypedData({
      domain: usdcDomain,
      types: transferAuthTypes,
      primaryType: 'TransferWithAuthorization',
      message,
    });
    // Validate low-S / shape locally before sending.
    parseSignature(signature);

    const body = {
      paymentPayload: {
        x402Version: 1,
        scheme: 'exact',
        network: 'base',
        payload: {
          signature,
          authorization: {
            from,
            to: DEST,
            value: bal.toString(),
            validAfter: '0',
            validBefore: String(now + 3600),
            nonce: message.nonce,
          },
        },
      },
      paymentRequirements: {
        scheme: 'exact',
        network: 'base',
        maxAmountRequired: bal.toString(),
        resource: 'https://swarmwage.com/tournament/recover',
        description: 'Post-tournament wallet recovery sweep',
        mimeType: 'application/json',
        payTo: DEST,
        maxTimeoutSeconds: 300,
        asset: USDC_BASE,
      },
    };

    const endpoint = MODE === 'verify' ? '/verify' : '/settle';
    let res: Response;
    try {
      res = await fetch(FACILITATOR + endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (e) {
      console.log(`  ${id.padEnd(10)} ${from}  ${(Number(bal) / 1e6).toFixed(4)} USDC — NETWORK ERROR: ${String(e)}`);
      await sleep(DELAY_MS);
      continue;
    }
    const json: any = await res.json().catch(() => ({}));

    if (MODE === 'verify') {
      const ok = res.status === 200 && json.isValid === true;
      console.log(`  ${id.padEnd(10)} ${from}  ${(Number(bal) / 1e6).toFixed(4)} USDC — ${ok ? 'VALID ✓' : `INVALID ✗ (${res.status} ${json.invalidReason ?? json.error ?? JSON.stringify(json)})`}`);
      if (ok) { okCount++; totalSwept += bal; }
    } else {
      const ok = res.status === 200 && json.success === true;
      if (ok) {
        console.log(`  ${id.padEnd(10)} ${from}  ${(Number(bal) / 1e6).toFixed(4)} USDC — SETTLED ✓  tx ${json.transaction}`);
        okCount++; totalSwept += bal;
        txs.push({ id, tx: json.transaction, usdc: Number(bal) / 1e6 });
      } else {
        console.log(`  ${id.padEnd(10)} ${from}  ${(Number(bal) / 1e6).toFixed(4)} USDC — FAILED ✗ (${res.status} ${json.errorReason ?? json.error ?? JSON.stringify(json)})`);
      }
    }

    await sleep(DELAY_MS);

    if (LIMIT > 0 && okCount >= LIMIT) {
      console.log(`\n  LIMIT=${LIMIT} reached — stopping.`);
      break;
    }
  }

  console.log('');
  console.log(`${MODE === 'verify' ? 'Verified' : 'Settled'}: ${okCount} wallets, ${(Number(totalSwept) / 1e6).toFixed(4)} USDC`);
  if (MODE === 'settle' && txs.length) {
    console.log('\nTx hashes:');
    for (const t of txs) console.log(`  ${t.id}  ${t.usdc.toFixed(4)} USDC  https://basescan.org/tx/${t.tx}`);
  }
})().catch((e) => {
  console.error('Recovery failed:', e);
  process.exit(1);
});
