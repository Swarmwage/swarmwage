#!/usr/bin/env node
// One-shot helper: generate persistent seller wallets and write them to
// each examples/seller-*/.env.local (gitignored). Idempotent: skips sellers
// that already have a SELLER_PRIVATE_KEY.
//
// Usage:
//   pnpm --filter @swarmwage/example-demo-buyer exec node scripts/generate-seller-wallets.mjs
//
// License: MIT

import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, "..", "..", "..");
const SELLERS = [
  "seller-chart-gen",
  "seller-code-exec",
  "seller-data-extract",
  "seller-image-gen",
  "seller-audio-transcribe",
];

const summary = [];
for (const s of SELLERS) {
  const envPath = resolve(REPO, "examples", s, ".env.local");
  let key;
  let action;
  if (existsSync(envPath)) {
    const cur = readFileSync(envPath, "utf8");
    const m = cur.match(/^SELLER_PRIVATE_KEY=(0x[0-9a-fA-F]+)/m);
    if (m) {
      key = m[1];
      action = "kept";
    } else {
      key = generatePrivateKey();
      writeFileSync(envPath, cur + `\nSELLER_PRIVATE_KEY=${key}\n`, "utf8");
      action = "appended";
    }
  } else {
    key = generatePrivateKey();
    writeFileSync(envPath, `SELLER_PRIVATE_KEY=${key}\n`, "utf8");
    action = "created";
  }
  summary.push({
    seller: s,
    address: privateKeyToAccount(key).address,
    action,
  });
}

console.log(
  "\nSeller wallets (the same address works on Base mainnet AND Base Sepolia):\n",
);
for (const r of summary) {
  console.log(`  ${r.seller.padEnd(28)} ${r.address}  [${r.action}]`);
}
console.log(
  "\nKeys written to examples/seller-*/.env.local (gitignored). NEVER commit.",
);
