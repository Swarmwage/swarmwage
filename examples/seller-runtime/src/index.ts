// Swarmwage example seller runtime — common HTTP and x402 lifecycle
// License: MIT

import { serve } from "@hono/node-server";
import {
  canonicalize,
  ENDPOINT_VERIFY_PATH,
  PROTOCOL_VERSION,
  signEndpointVerify,
  submitReceipt,
  type AgentId,
  type Hex,
  type Listing,
} from "@swarmwage/agent-sdk";
import { Hono, type Context } from "hono";
import { keccak256, toBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { paymentMiddleware, type Network } from "x402-hono";
import {
  clientIp,
  dailyBudgetGuard,
  DailyBudget,
  firstCallFreeGate,
  inMemoryTracker,
  rateLimit,
  SlidingWindowLimiter,
} from "./guards.js";

export * from "./guards.js";

const ZERO_AGENT = "0x0000000000000000000000000000000000000000" as AgentId;
const ZERO_HASH = `0x${"0".repeat(64)}` as Hex;

type Verification = {
  checks: Array<{ name: string; passed: boolean }>;
  all_passed: boolean;
};

type SellerEnv = {
  Variables: {
    pendingReceipt?: { payload: Parameters<typeof submitReceipt>[0]["payload"] };
    freeCall?: boolean;
    freeCallBuyerId?: string;
  };
};

export type SellerContext = Context<SellerEnv>;

export interface FulfilledHire {
  result: unknown;
  verification: Verification;
  meta?: Record<string, unknown>;
}

export interface SellerRuntimeOptions {
  identity: {
    privateKey: Hex;
    serviceName: string;
    /**
     * Payment recipient address, when split from the identity key (GH #11).
     * Address ONLY — its private key never touches this process. Payments
     * land here; the identity key signs listings/receipts/endpoint proofs
     * but cannot spend revenue. Wire via SELLER_PAYEE_ADDRESS. Omit for the
     * legacy single-EOA setup (payments go to the identity address).
     */
    payeeAddress?: AgentId;
  };
  listing: {
    capability: string;
    priceUsdc: string;
    maxLatencyMs: number;
    firstCallFree: boolean;
    publicUrl: string;
    registryUrl: string;
    publishedMessage: string;
  };
  payment: {
    network: Network;
    facilitatorUrl: `${string}://${string}`;
    validateSettlementHash?: boolean;
  };
  limits: {
    perIp: number;
    windowMs: number;
    maxDailyHires: number;
    maxDailySpendUsd: number;
    estimatedUpstreamUsd: number;
  };
  metadata: Record<string, unknown>;
  fulfill: (
    params: unknown,
    context: SellerContext,
  ) => Promise<FulfilledHire | Response>;
  configure?: (app: Hono<SellerEnv>, agentId: AgentId) => void;
}

export function priceUsdcToAtomic(price: string): string {
  const [intPart, fracPart = ""] = price.split(".");
  const frac = (fracPart + "000000").slice(0, 6);
  const combined = `${intPart}${frac}`.replace(/^0+(?=\d)/, "");
  return combined === "" ? "0" : combined;
}

export function createSellerRuntime(opts: SellerRuntimeOptions) {
  const account = privateKeyToAccount(opts.identity.privateKey);
  const agentId = account.address.toLowerCase() as AgentId;
  // The ONE address payments go to: the declared payee or the identity
  // address. Used consistently for the listing's signed payee, the x402
  // middleware payTo, and the receipt — the same signed tuple end to end.
  // SELLER_PAYEE_ADDRESS is the env-driven default so every seller built on
  // this runtime gets the split without per-seller wiring.
  const rawPayee =
    opts.identity.payeeAddress ?? process.env.SELLER_PAYEE_ADDRESS;
  if (rawPayee && !/^0x[a-fA-F0-9]{40}$/.test(rawPayee)) {
    throw new Error(
      `${opts.identity.serviceName}: SELLER_PAYEE_ADDRESS must be a 0x-prefixed 20-byte address (got ${rawPayee.slice(0, 12)}…)`,
    );
  }
  const payee = rawPayee?.toLowerCase() as AgentId | undefined;
  const payTo = payee ?? (account.address as `0x${string}`);
  const tracker = inMemoryTracker();
  const app = new Hono<SellerEnv>();

  async function signTypedPayload(payload: object): Promise<Hex> {
    return account.signMessage({
      message: { raw: keccak256(toBytes(canonicalize(payload))) },
    });
  }

  async function publishListing(): Promise<void> {
    const payload = {
      agent_id: agentId,
      // Only present when split — legacy payloads stay byte-identical so
      // existing single-EOA listing signatures verify unchanged.
      ...(payee ? { payee } : {}),
      capability: opts.listing.capability,
      price_usdc: opts.listing.priceUsdc,
      currency: "USDC" as const,
      chain: "base" as const,
      max_latency_ms: opts.listing.maxLatencyMs,
      first_call_free: opts.listing.firstCallFree,
      endpoint: opts.listing.publicUrl,
    };
    const listing: Listing = {
      ...payload,
      signature: await signTypedPayload(payload),
    };
    const response = await fetch(`${opts.listing.registryUrl}/v1/listings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(listing),
    });
    if (!response.ok) {
      throw new Error(
        `Failed to publish listing: ${response.status} ${await response.text()}`,
      );
    }
    process.stderr.write(opts.listing.publishedMessage);
  }

  app.get("/", (c) =>
    c.json({
      name: `swarmwage seller — ${opts.listing.capability}`,
      agent_id: agentId,
      protocol: PROTOCOL_VERSION,
      ...opts.metadata,
    }),
  );
  app.get(ENDPOINT_VERIFY_PATH, async (c) => {
    const nonce = c.req.query("nonce");
    if (!nonce || nonce.length < 8 || nonce.length > 128) {
      return c.json({ error: "Invalid or missing nonce" }, 400);
    }
    return c.json(await signEndpointVerify(agentId, nonce, signTypedPayload));
  });
  opts.configure?.(app, agentId);

  const limiter = new SlidingWindowLimiter({
    limit: opts.limits.perIp,
    windowMs: opts.limits.windowMs,
  });
  setInterval(() => limiter.gc(), opts.limits.windowMs).unref();
  app.use("/hire", rateLimit(limiter, clientIp));
  app.use(
    "/hire",
    dailyBudgetGuard(
      new DailyBudget({
        maxHires: opts.limits.maxDailyHires,
        maxSpendUsd: opts.limits.maxDailySpendUsd,
      }),
      opts.limits.estimatedUpstreamUsd,
    ),
  );

  app.use("/hire", async (c, next) => {
    await next();
    const pending = c.get("pendingReceipt");
    if (!pending || c.res.status >= 400) return;
    let txHash = ZERO_HASH;
    const header = c.res.headers.get("X-PAYMENT-RESPONSE");
    if (header) {
      try {
        const decoded = JSON.parse(
          Buffer.from(header, "base64").toString("utf8"),
        ) as { transaction?: string; txHash?: string };
        const candidate = decoded.transaction ?? decoded.txHash;
        if (
          candidate &&
          (!opts.payment.validateSettlementHash || candidate.startsWith("0x"))
        ) {
          txHash = candidate as Hex;
        }
      } catch {
        // Malformed settlement metadata keeps the placeholder hash.
      }
    }
    void submitReceipt({
      registryUrl: opts.listing.registryUrl,
      sellerPrivateKey: opts.identity.privateKey,
      payload: { ...pending.payload, tx_hash: txHash },
    });
  });

  const paid = paymentMiddleware(
    payTo,
    {
      "POST /hire": {
        price: `$${opts.listing.priceUsdc}`,
        network: opts.payment.network,
      },
    },
    { url: opts.payment.facilitatorUrl },
  );
  app.use(
    "/hire",
    opts.listing.firstCallFree
      ? firstCallFreeGate({ paymentMiddleware: paid, tracker })
      : paid,
  );

  app.post("/hire", async (c) => {
    const startedAt = Date.now();
    const body = (await c.req.json()) as {
      protocol?: string;
      buyer_id?: AgentId;
      capability?: string;
      params?: unknown;
    };
    if (body.protocol !== PROTOCOL_VERSION) {
      return c.json(
        { error: `Unsupported protocol: ${body.protocol ?? "?"}` },
        400,
      );
    }
    if (body.capability !== opts.listing.capability) {
      return c.json(
        { error: `Capability not supported: ${body.capability}` },
        400,
      );
    }

    const fulfilled = await opts.fulfill(body.params, c);
    if (fulfilled instanceof Response) return fulfilled;

    const completedAt = Math.floor(Date.now() / 1000);
    const receiptId = `rcpt_${crypto.randomUUID()}`;
    const ratingToken = `rtt_${crypto.randomUUID()}`;
    const freeCall = c.get("freeCall") === true;
    if (freeCall) {
      const buyerKey = c.get("freeCallBuyerId");
      if (buyerKey) tracker.markSeen(buyerKey);
    }

    c.set("pendingReceipt", {
      payload: {
        protocol_version: PROTOCOL_VERSION,
        hire_id: receiptId,
        agent_id: agentId,
        ...(payee ? { payee } : {}),
        buyer: (body.buyer_id?.toLowerCase() as AgentId) ?? ZERO_AGENT,
        capability: body.capability ?? opts.listing.capability,
        amount_usdc_atomic: freeCall
          ? "0"
          : priceUsdcToAtomic(opts.listing.priceUsdc),
        network: opts.payment.network as "base" | "base-sepolia",
        tx_hash: ZERO_HASH,
        completed_at: new Date(completedAt * 1000).toISOString(),
        verification: {
          all_passed: fulfilled.verification.all_passed,
          checks: Object.fromEntries(
            fulfilled.verification.checks.map((check) => [
              check.name,
              check.passed,
            ]),
          ),
        },
      },
    });

    return c.json({
      protocol: PROTOCOL_VERSION,
      receipt: {
        receipt_id: receiptId,
        buyer_id: body.buyer_id ?? ZERO_AGENT,
        seller_id: agentId,
        capability: body.capability,
        tx_hash: ZERO_HASH,
        price_paid_usdc: freeCall ? "0.00" : opts.listing.priceUsdc,
        completed_at: completedAt,
        first_call_free: freeCall,
      },
      result: fulfilled.result,
      verification: fulfilled.verification,
      rating_token: ratingToken,
      _meta: {
        ...fulfilled.meta,
        latency_ms: Date.now() - startedAt,
        first_call_free: freeCall,
      },
    });
  });

  return {
    app,
    agentId,
    publishListing,
    async start(port: number, listeningMessage: string): Promise<void> {
      try {
        await publishListing();
      } catch (error) {
        process.stderr.write(
          `${opts.identity.serviceName}: WARN failed to publish listing — ${(error as Error).message}\n`,
        );
      }
      serve({ fetch: app.fetch, port }, () => {
        process.stderr.write(listeningMessage);
      });
    },
  };
}
