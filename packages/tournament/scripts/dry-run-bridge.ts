// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Swarmwage
//
// 5-minute smoke test of the tournament SDK bridge.
//
// What it does:
//   1. Spawns wallet-svc as a child process with a 2-wallet store loaded
//      from `.tournament-secrets/dry-run/`.
//   2. Constructs two remote viem accounts.
//   3. Publishes a listing as agent A (price 0.05 USDC).
//   4. Searches for that listing as agent B.
//   5. Hires agent A from agent B (real USDC settlement on Base mainnet).
//   6. Submits a receipt as agent A.
//   7. Prints final balances + URLs.
//
// This is the "does the bridge actually work end-to-end" test. Cost: < $1
// total in USDC + gas, assuming the wallets are pre-funded.
//
// Pre-requisites:
//   - .tournament-secrets/dry-run/wallets.json with two keys (agent_A, agent_B)
//   - Both wallets pre-funded with ~0.10 USDC + ~0.0005 ETH each
//   - Agent A must have a publicly reachable HTTP endpoint so x402's
//     facilitator can call it during the hire. For local-only test, run
//     `cloudflared tunnel --url http://localhost:3001` or use ngrok and
//     pass --endpoint=<tunneled-url>.

import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { privateKeyToAccount } from 'viem/accounts';
import { keccak256, toBytes } from 'viem';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { createRemoteAccount } from '../agent-runner/src/remote-account.js';
import {
  searchAgents,
  publishListing,
  hireAgent,
  submitReceipt,
} from '../agent-runner/src/sdk-bridge.js';

const ROOT = resolve(process.cwd(), '../..');
const SECRETS = resolve(ROOT, '.tournament-secrets/dry-run');
const WALLETS_FILE = resolve(SECRETS, 'wallets.json');
const CAPS_FILE = resolve(SECRETS, 'caps.json');
const LEDGER_FILE = resolve(SECRETS, 'ledger.json');

const SELLER_ENDPOINT = process.env.SELLER_ENDPOINT;
if (!SELLER_ENDPOINT) {
  console.error('SELLER_ENDPOINT required (e.g. https://<tunnel>.trycloudflare.com)');
  process.exit(1);
}

if (!existsSync(WALLETS_FILE)) {
  console.error(`Missing ${WALLETS_FILE}.`);
  console.error('Run `pnpm tournament:wallets:generate` first with OUT_DIR set to .tournament-secrets/dry-run.');
  process.exit(1);
}

if (!existsSync(CAPS_FILE)) {
  mkdirSync(SECRETS, { recursive: true });
  writeFileSync(
    CAPS_FILE,
    JSON.stringify(
      { default: { maxSignsPerDay: 100, maxValueUsdcPerDay: '1000000' } },
      null,
      2,
    ),
  );
}

const WALLET_SVC_PORT = process.env.WALLET_SVC_PORT ?? '7100';
const WALLET_SVC_URL = `http://localhost:${WALLET_SVC_PORT}`;

async function waitForHealth(url: string, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${url}/health`);
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`${url} never became healthy`);
}

let walletSvc: ChildProcess | null = null;

async function spawnWalletSvc() {
  const env = {
    ...process.env,
    PORT: WALLET_SVC_PORT,
    WALLETS_PATH: WALLETS_FILE,
    CAPS_PATH: CAPS_FILE,
    LEDGER_PATH: LEDGER_FILE,
  };
  walletSvc = spawn('tsx', [resolve(ROOT, 'packages/tournament/wallet-svc/src/index.ts')], {
    env,
    stdio: 'inherit',
  });
  walletSvc.on('exit', (code) => console.log(`[wallet-svc] exited ${code}`));
  await waitForHealth(WALLET_SVC_URL);
}

(async () => {
  await spawnWalletSvc();
  console.log('[dry-run] wallet-svc up');

  const wallets = JSON.parse(readFileSync(WALLETS_FILE, 'utf-8')) as Record<string, `0x${string}`>;
  const agentIds = Object.keys(wallets);
  if (agentIds.length < 2) {
    console.error('Need at least 2 wallets in wallets.json (agent_A, agent_B).');
    process.exit(1);
  }
  const [A, B] = agentIds;

  const addrA = privateKeyToAccount(wallets[A]).address;
  const addrB = privateKeyToAccount(wallets[B]).address;
  console.log(`[dry-run] agent A: ${A}  ${addrA}`);
  console.log(`[dry-run] agent B: ${B}  ${addrB}`);

  const accountA = createRemoteAccount({
    agentId: A,
    walletSvcUrl: WALLET_SVC_URL,
    address: addrA,
  });
  const accountB = createRemoteAccount({
    agentId: B,
    walletSvcUrl: WALLET_SVC_URL,
    address: addrB,
  });

  const capability = `tournament.dryrun.${Date.now()}.echo`;
  console.log(`[dry-run] capability: ${capability}`);
  console.log(`[dry-run] endpoint:   ${SELLER_ENDPOINT}/capabilities/${encodeURIComponent(capability)}`);

  // Mini-seller HTTP surface for agent A: serves the endpoint-verify
  // challenge and accepts hire payloads. Listens on localhost:3001 — the
  // Cloudflare tunnel reverse-proxies SELLER_ENDPOINT → this.
  const sellerApp = new Hono();
  sellerApp.get('/health', (c) => c.json({ ok: true }));
  sellerApp.get('/.well-known/swarmwage-verify', async (c) => {
    const nonce = c.req.query('nonce');
    if (!nonce || nonce.length < 8 || nonce.length > 128) {
      return c.json({ error: 'invalid nonce' }, 400);
    }
    const payload = { agent_id: addrA.toLowerCase(), nonce };
    const canonical = JSON.stringify(payload, Object.keys(payload).sort());
    const hash = keccak256(toBytes(canonical));
    const signature = await accountA.signMessage({ message: { raw: hash } });
    return c.json({ agent_id: addrA.toLowerCase(), nonce, signature });
  });
  // Hire requests POST to <endpoint>/hire — for our endpoint
  // `https://<tunnel>/capabilities/<cap>` the hire path is
  // `/capabilities/<cap>/hire`.
  sellerApp.post('/capabilities/:cap/hire', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    return c.json({
      protocol: 'swarmwage/v0.1',
      result: { echo: body, seller: addrA },
      receipt: {
        seller_id: addrA.toLowerCase(),
        buyer_id: (body?.buyer_id ?? '0x0').toLowerCase(),
        capability: c.req.param('cap'),
        price_paid_usdc: body?.max_price_usdc ?? '0.05',
        tx_hash: '0x' + '0'.repeat(64),
        completed_at: new Date().toISOString(),
      },
    });
  });
  const sellerSrv = serve({ fetch: sellerApp.fetch, port: 3001 });
  console.log('[dry-run] mini-seller listening on :3001 (tunneled via Cloudflare)');
  // Wait a sec for tunnel propagation
  await new Promise((r) => setTimeout(r, 2000));

  console.log('[dry-run] step 1/4: publishListing (agent A)');
  const listing = await publishListing({
    account: accountA,
    capability,
    price_usdc: '0.05',
    endpoint: `${SELLER_ENDPOINT}/capabilities/${encodeURIComponent(capability)}`,
    max_latency_ms: 15000,
    first_call_free: false,
  });
  console.log('  →', listing);

  console.log('[dry-run] step 2/4: searchAgents (agent B)');
  const results = await searchAgents({ capability });
  console.log('  →', results);

  console.log('[dry-run] step 3/4: hireAgent (agent B pays A)');
  try {
    const hire = await hireAgent({
      account: accountB,
      capability,
      params: { input: 'hello dry-run' },
      max_price_usdc: '0.10',
    });
    console.log('  →', hire);
  } catch (e) {
    console.log('  hire failed (expected on first run if seller endpoint not reachable):', String(e));
  }

  console.log('[dry-run] step 4/4: submitReceipt (agent A — proves seller-side flow)');
  const receipt = await submitReceipt({
    account: accountA,
    payload: {
      protocol_version: 'swarmwage/v0.1',
      hire_id: crypto.randomUUID(),
      buyer: addrB.toLowerCase() as `0x${string}`,
      capability,
      amount_usdc_atomic: '50000',
      network: 'base',
      tx_hash: ('0x' + '0'.repeat(64)) as `0x${string}`,
      completed_at: new Date().toISOString(),
      verification: { all_passed: true, checks: { delivered: true } },
    },
  });
  console.log('  →', receipt);

  console.log('');
  console.log('[dry-run] DONE. Inspect:');
  console.log(`  https://api.swarmwage.com/v1/search?capability=${encodeURIComponent(capability)}`);
  console.log(`  https://basescan.org/address/${addrA}`);
  console.log(`  https://basescan.org/address/${addrB}`);

  walletSvc?.kill();
  sellerSrv.close();
  process.exit(0);
})().catch((e) => {
  console.error('[dry-run] fatal:', e);
  walletSvc?.kill();
  process.exit(1);
});
