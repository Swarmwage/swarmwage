#!/usr/bin/env node
// Read-only: print ETH + USDC balances on Base mainnet for buyer + 5 sellers.
// Uses the public Base RPC (no Alchemy key required for reads).
//
// Usage:
//   pnpm --filter @swarmwage/example-demo-buyer exec node scripts/check-mainnet-balances.mjs
//
// License: MIT

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, http, formatEther, formatUnits } from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, "..", "..", "..");

const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const ERC20_BALANCE_OF = {
  inputs: [{ name: "account", type: "address" }],
  name: "balanceOf",
  outputs: [{ name: "", type: "uint256" }],
  stateMutability: "view",
  type: "function",
};

function readEnvKey(envPath, varName) {
  if (!existsSync(envPath)) return null;
  const m = readFileSync(envPath, "utf8").match(
    new RegExp(`^${varName}=(0x[0-9a-fA-F]+)`, "m"),
  );
  return m ? m[1] : null;
}

const wallets = [];
const buyerKey = readEnvKey(
  resolve(REPO, "examples/demo-buyer/.env.local"),
  "BUYER_PRIVATE_KEY",
);
if (buyerKey) {
  wallets.push({
    label: "demo-buyer",
    address: privateKeyToAccount(buyerKey).address,
  });
}
for (const s of [
  "seller-chart-gen",
  "seller-code-exec",
  "seller-data-extract",
  "seller-image-gen",
  "seller-audio-transcribe",
]) {
  const k = readEnvKey(
    resolve(REPO, "examples", s, ".env.local"),
    "SELLER_PRIVATE_KEY",
  );
  if (k) wallets.push({ label: s, address: privateKeyToAccount(k).address });
}

// Read RPC from env so the operator can point at a dedicated Alchemy /
// QuickNode / etc endpoint. The default https://mainnet.base.org is
// public and aggressively rate-limited (~5 reads/sec) — six balance
// reads in a tight loop trip the limiter on the last call.
const rpcUrl = process.env.RPC_URL;
const client = createPublicClient({
  chain: base,
  transport: http(rpcUrl),
});
if (!rpcUrl) {
  console.log(
    "Note: using public Base RPC (rate-limited). Set RPC_URL to a dedicated endpoint to avoid 'over rate limit' errors.\n",
  );
}

console.log(`\nBase mainnet balances (chain id ${base.id}):\n`);
console.log(
  `  ${"role".padEnd(28)} ${"address".padEnd(44)} ${"ETH".padStart(12)}  ${"USDC".padStart(12)}`,
);
console.log(`  ${"-".repeat(28)} ${"-".repeat(44)} ${"-".repeat(12)}  ${"-".repeat(12)}`);
for (const w of wallets) {
  const eth = await client.getBalance({ address: w.address });
  const usdc = await client.readContract({
    address: USDC_BASE,
    abi: [ERC20_BALANCE_OF],
    functionName: "balanceOf",
    args: [w.address],
  });
  console.log(
    `  ${w.label.padEnd(28)} ${w.address}  ${formatEther(eth).padStart(12)}  ${formatUnits(usdc, 6).padStart(12)}`,
  );
}
console.log("");
