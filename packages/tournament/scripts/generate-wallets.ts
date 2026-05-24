// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Swarmwage
//
// Generate N agent wallets for a tournament and write them to disk.
//
// Output:
//   .tournament-secrets/wallets.json          (plaintext — write only to tmpfs)
//   .tournament-secrets/wallets.public.json   (public addresses only — safe to share)
//   packages/tournament/wallet-svc/.dev/caps.json (default caps, also safe)
//
// You MUST encrypt wallets.json before storing long-term. Suggested:
//   gpg --symmetric --cipher-algo AES256 wallets.json
//   shred -u wallets.json
//
// Never commit either of these files. Both paths are in root .gitignore.

import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

const N = Number(process.env.N ?? 10);
const OUT_DIR = process.env.OUT_DIR ?? resolve(process.cwd(), '../../.tournament-secrets');
const NOW = new Date().toISOString();

function pad(n: number, w = 2): string {
  return String(n).padStart(w, '0');
}

function ensureDir(p: string) {
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
}

ensureDir(OUT_DIR);

const wallets: Record<string, string> = {};
const publicWallets: Array<{ agent_id: string; address: string }> = [];

for (let i = 1; i <= N; i++) {
  const id = `agent_${pad(i)}`;
  const pk = generatePrivateKey();
  const acct = privateKeyToAccount(pk);
  wallets[id] = pk;
  publicWallets.push({ agent_id: id, address: acct.address });
}

const walletsPath = resolve(OUT_DIR, 'wallets.json');
const publicPath = resolve(OUT_DIR, 'wallets.public.json');
const capsPath = resolve(OUT_DIR, 'caps.json');

writeFileSync(walletsPath, JSON.stringify(wallets, null, 2), {
  mode: 0o600,
  encoding: 'utf-8',
});
writeFileSync(
  publicPath,
  JSON.stringify({ generated_at: NOW, count: N, wallets: publicWallets }, null, 2),
);
writeFileSync(
  capsPath,
  JSON.stringify(
    {
      default: {
        maxSignsPerDay: 500,
        // 10 USDC = 10_000_000 base units (USDC has 6 decimals).
        maxValueUsdcPerDay: '10000000',
      },
    },
    null,
    2,
  ),
);

console.log(`Generated ${N} wallets`);
console.log(`  ${walletsPath}      (PRIVATE — encrypt + shred immediately)`);
console.log(`  ${publicPath}       (safe to share)`);
console.log(`  ${capsPath}         (caps config)`);
console.log('');
console.log('Public addresses (fund these to start the tournament):');
for (const w of publicWallets) {
  console.log(`  ${w.agent_id}  ${w.address}`);
}
console.log('');
console.log('Next:');
console.log('  1. gpg --symmetric --cipher-algo AES256 wallets.json && shred -u wallets.json');
console.log('  2. pnpm tournament:wallets:fund  (sends 5 USDC + gas from ops wallet)');
