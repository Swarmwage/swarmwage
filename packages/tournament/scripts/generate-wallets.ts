// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Swarmwage
//
// Generate the tournament roster (agent + buyer wallets) AND the per-wallet
// bearer tokens the wallet-svc auth boundary requires.
//
// Output (all under OUT_DIR, default .tournament-secrets/ — gitignored):
//   wallets.json          plaintext private keys — write only to tmpfs, encrypt
//   wallets.public.json   public addresses only — safe to share
//   caps.json             default caps — safe
//   tokens.json           agent_id → bearer token — SECRET; mounted into wallet-svc
//   orchestrator.token    single token for /internal/* reads — SECRET
//   tokens.env            compose-interpolation snippet — SECRET; append to the
//                         docker .env so each container gets ONLY its own token
//
// Tokens bind a caller to exactly one wallet id (see wallet-svc/src/auth.ts).
// Token VALUES are never printed to stdout (transcript hygiene) — only paths +
// public addresses are.
//
// You MUST encrypt wallets.json before storing long-term:
//   gpg --symmetric --cipher-algo AES256 wallets.json && shred -u wallets.json
// Never commit any of these files. All paths are in root .gitignore.

import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

const N = Number(process.env.N ?? 10);
const BUYER_IDS = (process.env.BUYER_IDS ?? 'buyer_01,buyer_02')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const OUT_DIR = process.env.OUT_DIR ?? resolve(process.cwd(), '../../.tournament-secrets');
const NOW = new Date().toISOString();

function pad(n: number, w = 2): string {
  return String(n).padStart(w, '0');
}
/** 32 random bytes as hex — an opaque bearer token (64 chars). */
function token(): string {
  return randomBytes(32).toString('hex');
}
function ensureDir(p: string) {
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
}

ensureDir(OUT_DIR);

// Full roster: N agents + the buyer ids (matches docker-compose: 10 + 2).
const rosterIds: string[] = [
  ...Array.from({ length: N }, (_, i) => `agent_${pad(i + 1)}`),
  ...BUYER_IDS,
];

const wallets: Record<string, string> = {};
const tokens: Record<string, string> = {};
const publicWallets: Array<{ agent_id: string; address: string }> = [];

for (const id of rosterIds) {
  const pk = generatePrivateKey();
  wallets[id] = pk;
  tokens[id] = token();
  publicWallets.push({ agent_id: id, address: privateKeyToAccount(pk).address });
}

const orchestratorToken = token();

const walletsPath = resolve(OUT_DIR, 'wallets.json');
const publicPath = resolve(OUT_DIR, 'wallets.public.json');
const capsPath = resolve(OUT_DIR, 'caps.json');
const tokensPath = resolve(OUT_DIR, 'tokens.json');
const orchTokenPath = resolve(OUT_DIR, 'orchestrator.token');
const tokensEnvPath = resolve(OUT_DIR, 'tokens.env');

writeFileSync(walletsPath, JSON.stringify(wallets, null, 2), { mode: 0o600, encoding: 'utf-8' });
writeFileSync(tokensPath, JSON.stringify(tokens, null, 2), { mode: 0o600, encoding: 'utf-8' });
writeFileSync(orchTokenPath, orchestratorToken + '\n', { mode: 0o600, encoding: 'utf-8' });

// Compose-interpolation snippet: each container references ${WALLET_SVC_TOKEN_<id>}
// so it receives ONLY its own token. Append into the docker `.env`.
const envLines = [
  ...rosterIds.map((id) => `WALLET_SVC_TOKEN_${id}=${tokens[id]}`),
  `ORCHESTRATOR_TOKEN=${orchestratorToken}`,
  '',
].join('\n');
writeFileSync(tokensEnvPath, envLines, { mode: 0o600, encoding: 'utf-8' });

writeFileSync(
  publicPath,
  JSON.stringify({ generated_at: NOW, count: rosterIds.length, wallets: publicWallets }, null, 2),
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

console.log(
  `Generated ${rosterIds.length} wallets (${N} agents + ${BUYER_IDS.length} buyers) + per-wallet tokens`,
);
console.log(`  ${walletsPath}      (PRIVATE — encrypt + shred immediately)`);
console.log(`  ${tokensPath}       (PRIVATE — bearer tokens, mounted into wallet-svc)`);
console.log(`  ${orchTokenPath}    (PRIVATE — orchestrator token)`);
console.log(`  ${tokensEnvPath}    (PRIVATE — append into the docker .env)`);
console.log(`  ${publicPath}       (safe to share)`);
console.log(`  ${capsPath}         (caps config)`);
console.log('');
console.log('Token VALUES are intentionally not printed. See tokens.json / tokens.env.');
console.log('');
console.log('Public addresses (fund these to start the tournament):');
for (const w of publicWallets) {
  console.log(`  ${w.agent_id}  ${w.address}`);
}
console.log('');
console.log('Next:');
console.log('  1. gpg --symmetric --cipher-algo AES256 wallets.json && shred -u wallets.json');
console.log('  2. cat tokens.env >> packages/tournament/ops/docker/.env   # per-container tokens');
console.log('  3. pnpm tournament:wallets:fund  (sends USDC + gas from ops wallet)');
