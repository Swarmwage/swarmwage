// Anti-hijack smoke test.
// 1. Inject a "ghost" listing into the registry: a freshly-generated agent_id
//    A whose endpoint points to the live seller (which is operated by a
//    different key K).
// 2. Buyer attempts to hire agent_id=A. The live :4003 returns 402 with
//    payTo=K. Without the fix, the buyer would pay K. With the fix, the
//    SDK throws SellerMismatchError before any signature.
// 3. Buyer then hires the legitimate agent_id=K — should succeed normally.

import { keccak256, toBytes, createPublicClient, http, formatUnits } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import {
  AgentClient,
  SellerMismatchError,
  PROTOCOL_VERSION,
  canonicalize,
} from "@swarmwage/agent-sdk";

const REGISTRY_URL = "http://localhost:3010";
const ENDPOINT = "http://localhost:4003";
const NETWORK = "base-sepolia";

const liveSellerAddress = process.env.LIVE_SELLER_ADDRESS;
if (!liveSellerAddress) {
  throw new Error("LIVE_SELLER_ADDRESS env var required");
}

const buyerKey = process.env.BUYER_PRIVATE_KEY;
if (!buyerKey) {
  throw new Error("BUYER_PRIVATE_KEY env var required (source .env.local)");
}

const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const ABI = [{
  type: "function", name: "balanceOf", stateMutability: "view",
  inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }],
}];
const onChain = createPublicClient({ chain: baseSepolia, transport: http("https://sepolia.base.org") });

async function balanceOf(addr) {
  const bal = await onChain.readContract({
    address: USDC, abi: ABI, functionName: "balanceOf", args: [addr],
  });
  return formatUnits(bal, 6);
}

// ---------- Step 1: inject ghost listing ----------
const ghostKey = generatePrivateKey();
const ghostAccount = privateKeyToAccount(ghostKey);
const ghostId = ghostAccount.address.toLowerCase();
console.log(`\n[setup] ghost agent_id A: ${ghostId}`);
console.log(`[setup] live seller_id K: ${liveSellerAddress}`);
console.log(`[setup] both listings will point to endpoint ${ENDPOINT}`);

const ghostPayload = {
  agent_id: ghostId,
  capability: "code.execute.sandboxed",
  price_usdc: "0.02",
  currency: "USDC",
  chain: "base",
  max_latency_ms: 35000,
  first_call_free: true,
  endpoint: ENDPOINT,
};
const ghostCanonical = canonicalize(ghostPayload);
const ghostHash = keccak256(toBytes(ghostCanonical));
const ghostSig = await ghostAccount.signMessage({ message: { raw: ghostHash } });
const ghostListing = { ...ghostPayload, signature: ghostSig };
const pubRes = await fetch(`${REGISTRY_URL}/v1/listings`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(ghostListing),
});
console.log(`[setup] ghost listing published: HTTP ${pubRes.status}`);

// ---------- Step 2: client + buyer balance pre-test ----------
const client = new AgentClient({
  privateKey: buyerKey,
  registryUrl: REGISTRY_URL,
  network: NETWORK,
});
const balPre = await balanceOf(client.agentId);
console.log(`\n[buyer] agent_id: ${client.agentId}`);
console.log(`[buyer] balance pre-test: ${balPre} USDC`);

// ---------- Step 3: NEGATIVE — hire ghost A ----------
console.log(`\n=== NEGATIVE TEST — hire agent_id=A (ghost) ===`);
console.log(`Expecting: SellerMismatchError BEFORE any payment`);
let negResult;
try {
  await client.hire({
    agent_id: ghostId,
    endpoint: ENDPOINT,
    capability: "code.execute.sandboxed",
    params: { code: "print('should never run')\n", language: "python", timeout_ms: 3000 },
    max_price_usdc: "1.00",
    max_latency_ms: 30000,
  });
  negResult = "FAIL — hire completed without throwing (anti-hijack didn't fire)";
} catch (err) {
  if (err instanceof SellerMismatchError) {
    negResult = `PASS — SellerMismatchError caught: expected=${err.expected.slice(0,10)}…  actual=${err.actual.slice(0,10)}…`;
  } else {
    negResult = `UNEXPECTED — ${err.constructor.name}: ${err.message}`;
  }
}
console.log(negResult);
const balMid = await balanceOf(client.agentId);
console.log(`[buyer] balance after negative test: ${balMid} USDC (should equal pre)`);
const balUnchanged = balPre === balMid;
console.log(`[buyer] balance unchanged: ${balUnchanged ? "YES — no on-chain payment happened" : "NO — money moved (BAD)"}`);

// ---------- Step 4: POSITIVE — hire legitimate K ----------
console.log(`\n=== POSITIVE TEST — hire agent_id=K (legit) ===`);
console.log(`Expecting: success, hire completes with valid receipt`);
let posResult;
let receiptHash = null;
try {
  const resp = await client.hire({
    agent_id: liveSellerAddress.toLowerCase(),
    endpoint: ENDPOINT,
    capability: "code.execute.sandboxed",
    params: { code: "print('hello from anti-hijack test')\n", language: "python", timeout_ms: 3000 },
    max_price_usdc: "1.00",
    max_latency_ms: 30000,
  });
  receiptHash = resp.receipt.tx_hash;
  posResult = `PASS — hire ok, exit_code=${resp.result.exit_code}, tx=${receiptHash.slice(0,12)}…`;
} catch (err) {
  posResult = `FAIL — ${err.constructor.name}: ${err.message}`;
}
console.log(posResult);
const balPost = await balanceOf(client.agentId);
console.log(`[buyer] balance after positive test: ${balPost} USDC (should be -0.02 from mid)`);

// ---------- Summary ----------
console.log(`\n--- summary ---`);
console.log(`negative: ${negResult.startsWith("PASS") ? "✅" : "❌"} ${negResult}`);
console.log(`positive: ${posResult.startsWith("PASS") ? "✅" : "❌"} ${posResult}`);
console.log(`balance integrity: pre=${balPre} → mid=${balMid} → post=${balPost}`);
if (receiptHash) {
  console.log(`positive tx: https://sepolia.basescan.org/tx/${receiptHash}`);
}
