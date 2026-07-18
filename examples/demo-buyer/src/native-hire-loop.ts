// Swarmwage buyer demo — mock native hire reliability loop
// License: MIT
//
// Repeatable no-spend loop:
//   registry search -> native hire -> verifier -> seller-signed receipt -> reputation read

import { randomUUID } from "node:crypto";
import { keccak256, toBytes, verifyMessage } from "viem";
import { generatePrivateKey } from "viem/accounts";
import {
  AgentClient,
  PROTOCOL_VERSION,
  canonicalize,
  createWallet,
  submitReceipt,
  verify,
  type AgentId,
  type Hex,
  type HireResponse,
  type Listing,
  type ReceiptPayload,
  type Reputation,
} from "@swarmwage/agent-sdk";

const REGISTRY_URL = process.env.REGISTRY_URL ?? "https://registry.mock";
const SELLER_URL = process.env.SELLER_URL ?? "https://seller.mock";
const CAPABILITY = "code.execute.sandboxed";

const SELLER_PRIVATE_KEY = generatePrivateKey();
const sellerWallet = createWallet({ privateKey: SELLER_PRIVATE_KEY });
const ZERO_TX = zeroHash();

interface ReceiptRow extends ReceiptPayload {
  signature: Hex;
  receipt_id: string;
  ts: number;
}

interface HireRow {
  receipt_id: string;
  buyer_id: AgentId;
  seller_id: AgentId;
  capability: string;
  price_paid_usdc: string;
  verification_passed: boolean;
  latency_ms: number;
  completed_at: number;
}

interface MockState {
  receipts: ReceiptRow[];
  hires: HireRow[];
}

const listing: Omit<Listing, "signature"> = {
  agent_id: sellerWallet.agentId,
  capability: CAPABILITY,
  price_usdc: "0.01",
  currency: "USDC",
  chain: "base",
  max_latency_ms: 1000,
  first_call_free: true,
  endpoint: SELLER_URL,
};

function installMockFetch(state: MockState): () => void {
  const original = globalThis.fetch;

  globalThis.fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const req = input instanceof Request ? input : new Request(input, init);
    const parsedUrl = new URL(req.url);
    const bodyText = await req.clone().text();
    const body = bodyText ? (JSON.parse(bodyText) as Record<string, unknown>) : {};

    if (req.url === `${REGISTRY_URL}/v1/search`) {
      return json({
        agents: [
          {
            agent_id: listing.agent_id,
            listing,
            reputation: reputationFor(state),
          },
        ],
        next_cursor: null,
        match: "exact",
      });
    }

    if (req.url === `${SELLER_URL}/hire`) {
      return handleSellerHire(body);
    }

    if (
      parsedUrl.origin === REGISTRY_URL &&
      parsedUrl.pathname === `/v1/agents/${sellerWallet.agentId}/reputation`
    ) {
      return json(reputationFor(state));
    }

    if (
      parsedUrl.origin === REGISTRY_URL &&
      parsedUrl.pathname === `/v1/agents/${sellerWallet.agentId}/receipts`
    ) {
      const rows = [...state.receipts].sort((a, b) => b.ts - a.ts);
      return json({ agent_id: sellerWallet.agentId, count: rows.length, receipts: rows });
    }

    if (
      parsedUrl.origin === REGISTRY_URL &&
      parsedUrl.pathname === "/v1/receipts"
    ) {
      return handleReceiptSubmit(state, body);
    }

    throw new Error(`mock fetch: unmatched ${req.method} ${req.url}`);
  }) as typeof fetch;

  return () => void (globalThis.fetch = original);
}

async function handleSellerHire(body: Record<string, unknown>): Promise<Response> {
  const params = (body.params ?? {}) as Record<string, unknown>;
  const buyer = String(body.buyer_id) as AgentId;
  const hireId = String(body.nonce ?? randomUUID());
  const t0 = Date.now();

  const result = {
    stdout: "fibonacci(7): 0 1 1 2 3 5 8\nsum: 20\n",
    stderr: "",
    exit_code: 0,
    duration_ms: 12,
    truncated: false,
  };
  const verification = verify(CAPABILITY, params, result);
  const completedAt = new Date().toISOString();
  const receiptPayload: ReceiptPayload = {
    protocol_version: PROTOCOL_VERSION,
    hire_id: hireId,
    agent_id: sellerWallet.agentId,
    buyer,
    capability: CAPABILITY,
    amount_usdc_atomic: "0",
    network: "base-sepolia",
    tx_hash: ZERO_TX,
    completed_at: completedAt,
    verification: {
      all_passed: verification.all_passed,
      checks: Object.fromEntries(
        verification.checks.map((check) => [check.name, check.passed]),
      ),
    },
  };

  const receipt = await submitReceipt({
    registryUrl: REGISTRY_URL,
    sellerPrivateKey: SELLER_PRIVATE_KEY,
    payload: receiptPayload,
    logger: () => {},
  });

  if (!receipt.receipt_id) {
    return json({ error: receipt.error ?? "receipt submission failed" }, 500);
  }

  const response: HireResponse = {
    protocol: PROTOCOL_VERSION,
    receipt: {
      receipt_id: receipt.receipt_id,
      buyer_id: buyer,
      seller_id: sellerWallet.agentId,
      capability: CAPABILITY,
      tx_hash: ZERO_TX,
      price_paid_usdc: "0.00",
      completed_at: Math.floor(Date.parse(completedAt) / 1000),
    },
    result,
    verification,
    rating_token: `rate_${randomUUID()}`,
  };

  return json(response, verification.all_passed ? 200 : 422, {
    "X-Mock-Seller-Latency-Ms": String(Date.now() - t0),
  });
}

async function handleReceiptSubmit(
  state: MockState,
  body: Record<string, unknown>,
): Promise<Response> {
  const signature = body.signature as Hex | undefined;
  if (!signature) return json({ ok: false, error: "missing signature" }, 400);

  const { signature: _signature, ...payload } = body;
  if (String(payload.agent_id).toLowerCase() !== sellerWallet.agentId) {
    return json({ ok: false, error: "wrong seller" }, 401);
  }
  if (String(payload.buyer).toLowerCase() === sellerWallet.agentId) {
    return json({ ok: false, error: "self-hire blocked" }, 400);
  }

  const canonical = canonicalize(payload);
  const hash = keccak256(toBytes(canonical));
  const valid = await verifyMessage({
    address: sellerWallet.agentId,
    message: { raw: hash },
    signature,
  });
  if (!valid) return json({ ok: false, error: "invalid signature" }, 401);

  const existing = state.receipts.find(
    (r) =>
      r.hire_id === payload.hire_id &&
      r.agent_id.toLowerCase() === sellerWallet.agentId,
  );
  if (existing) {
    return json(
      { ok: false, error: "duplicate_hire_id", receipt_id: existing.receipt_id },
      409,
    );
  }

  const receiptId = `rcp_${randomUUID()}`;
  const receipt = {
    ...(payload as unknown as ReceiptPayload),
    signature,
    receipt_id: receiptId,
    ts: Date.now(),
  };
  state.receipts.push(receipt);
  state.hires.push({
    receipt_id: receiptId,
    buyer_id: receipt.buyer,
    seller_id: receipt.agent_id,
    capability: receipt.capability,
    price_paid_usdc: "0.00",
    verification_passed: receipt.verification.all_passed,
    latency_ms: 12,
    completed_at: Date.parse(receipt.completed_at),
  });

  return json({ ok: true, receipt_id: receiptId });
}

function reputationFor(state: MockState): Reputation {
  const hires = state.hires.filter((h) => h.seller_id === sellerWallet.agentId);
  const passed = hires.filter((h) => h.verification_passed).length;
  const avgLatency =
    hires.length === 0
      ? listing.max_latency_ms
      : hires.reduce((sum, h) => sum + h.latency_ms, 0) / hires.length;
  return {
    agent_id: sellerWallet.agentId,
    success_rate: hires.length === 0 ? 1 : passed / hires.length,
    avg_latency_ms: avgLatency,
    avg_cost_per_capability: hires.length === 0 ? {} : { [CAPABILITY]: "0.00" },
    last_24h_volume_usdc: "0.00",
    last_30d_hire_count: hires.length,
    total_ratings: 0,
    avg_stars: 0,
    claimed: false,
  };
}

function json(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function zeroHash(): Hex {
  return `0x${"0".repeat(64)}`;
}

async function main(): Promise<void> {
  const state: MockState = { receipts: [], hires: [] };
  const restore = installMockFetch(state);
  try {
    const client = new AgentClient({
      privateKey:
        (process.env.BUYER_PRIVATE_KEY as Hex | undefined) ??
        generatePrivateKey(),
      registryUrl: REGISTRY_URL,
      network: "base-sepolia",
      telemetry: false,
      reliability: false,
      facilitatorUrl: null,
    });

    const params = {
      code: "print('fibonacci demo')",
      language: "python",
      timeout_ms: 5000,
    };

    const search = await client.search({
      capability: CAPABILITY,
      max_price_usdc: "0.01",
      limit: 1,
    });
    const top = search[0];
    if (!top) throw new Error("mock native search returned no sellers");

    const hire = await client.hire({
      agent_id: top.agent_id,
      endpoint: top.listing.endpoint,
      capability: CAPABILITY,
      params,
      max_price_usdc: "0",
      max_latency_ms: 1000,
      validateSeller: false,
    });

    const reputation = await client.getReputation(sellerWallet.agentId);
    const receipts = state.receipts.map((receipt) => ({
      receipt_id: receipt.receipt_id,
      hire_id: receipt.hire_id,
      agent_id: receipt.agent_id,
      buyer: receipt.buyer,
      capability: receipt.capability,
      verification: receipt.verification,
      signature: receipt.signature,
    }));

    process.stdout.write(
      `${JSON.stringify(
        {
          search_count: search.length,
          seller_id: top.agent_id,
          hired_url: top.listing.endpoint,
          capability: CAPABILITY,
          price_paid_usdc: hire.receipt.price_paid_usdc,
          tx_hash: hire.receipt.tx_hash,
          receipt_id: hire.receipt.receipt_id,
          receipt_signature_verified: receipts.length === 1,
          verification_passed: hire.verification.all_passed,
          verification_checks: hire.verification.checks,
          reputation,
          receipts,
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    restore();
  }
}

main().catch((err) => {
  process.stderr.write(`native hire loop failed: ${(err as Error).message}\n`);
  process.exit(1);
});
