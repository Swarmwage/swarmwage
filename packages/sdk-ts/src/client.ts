// Swarmwage Agent SDK — main AgentClient
// License: MIT

import { createWalletClient, http } from "viem";
import { base, baseSepolia } from "viem/chains";
import { wrapFetchWithPayment } from "x402-fetch";
import {
  selectPaymentRequirements,
  type PaymentRequirementsSelector,
} from "x402/client";
import { Transport } from "./transport.js";
import { createWallet, type AgentWallet, type WalletConfig } from "./wallet.js";
import {
  createBudgetState,
  assertCanSpend,
  recordSpend,
  remaining as budgetRemaining,
  type BudgetState,
} from "./budget.js";
import { createTelemetry } from "./telemetry.js";
import { verify } from "./verification.js";
import {
  HireRefusedError,
  InvalidProtocolVersionError,
  SellerMismatchError,
  VerificationFailedError,
} from "./errors.js";
import {
  PROTOCOL_VERSION,
  type AgentId,
  type BudgetToken,
  type CapabilityId,
  type HireRequest,
  type HireResponse,
  type AsyncHireResponse,
  type JobStatus,
  type Listing,
  type RatingRequest,
  type Reputation,
  type SearchRequest,
  type SearchResponse,
  type SearchResultEntry,
  type Stars,
  type UsdcAmount,
} from "./types.js";

export type SwarmwageNetwork = "base" | "base-sepolia";

export interface AgentClientOptions extends WalletConfig {
  /** Override the canonical registry URL. */
  registryUrl?: string;
  /** Pre-authorized budget from the human operator. */
  budget?: BudgetToken;
  /** Force telemetry on/off. Defaults to env var `AGENT_TELEMETRY`. */
  telemetry?: boolean;
  /** Chain to use for x402 payments. Defaults to `base-sepolia`. */
  network?: SwarmwageNetwork;
  /** Override the JSON-RPC URL. Defaults to viem's public RPC for the network. */
  rpcUrl?: string;
}

export class AgentClient {
  readonly wallet: AgentWallet;
  readonly registryUrl: string;
  readonly network: SwarmwageNetwork;
  private budgetState: BudgetState | null;
  private readonly transport: Transport;
  private readonly telemetry: ReturnType<typeof createTelemetry>;
  private readonly walletClient: ReturnType<typeof createWalletClient>;

  constructor(opts: AgentClientOptions) {
    this.wallet = createWallet({ privateKey: opts.privateKey });
    this.registryUrl = opts.registryUrl ?? "https://api.swarmwage.com";
    this.network = opts.network ?? "base-sepolia";

    const chain = this.network === "base" ? base : baseSepolia;
    this.walletClient = createWalletClient({
      account: this.wallet.account,
      transport: http(opts.rpcUrl),
      chain,
    });

    // viem's `WalletClient` types `account` as `Account | undefined` even when
    // we know it's a defined PrivateKeyAccount; x402-fetch's SignerWallet type
    // requires the narrower form. We cast at the boundary.
    const paidFetch = wrapFetchWithPayment(
      globalThis.fetch,
      this.walletClient as Parameters<typeof wrapFetchWithPayment>[1],
    ) as unknown as typeof fetch;

    this.budgetState = opts.budget ? createBudgetState(opts.budget) : null;
    this.transport = new Transport({ baseUrl: this.registryUrl, paidFetch });
    this.telemetry = createTelemetry({
      enabled: opts.telemetry,
      agentId: this.wallet.agentId,
    });
  }

  // -----------------------------------------------------------------------
  // Identity
  // -----------------------------------------------------------------------

  get agentId(): AgentId {
    return this.wallet.agentId;
  }

  // -----------------------------------------------------------------------
  // Budget
  // -----------------------------------------------------------------------

  loadBudget(token: BudgetToken): void {
    this.budgetState = createBudgetState(token);
  }

  remainingBudget(): UsdcAmount {
    return this.budgetState ? budgetRemaining(this.budgetState) : "0.00";
  }

  // -----------------------------------------------------------------------
  // Discovery
  // -----------------------------------------------------------------------

  async search(req: SearchRequest): Promise<SearchResultEntry[]> {
    const res = await this.transport.json<SearchResponse>("/v1/search", {
      method: "POST",
      body: JSON.stringify(req),
    });
    this.telemetry.send({
      kind: "search",
      capability: req.capability,
      result_count: res.agents.length,
    });
    return res.agents;
  }

  async getReputation(agentId: AgentId): Promise<Reputation> {
    return this.transport.json<Reputation>(`/v1/agents/${agentId}/reputation`, {
      method: "GET",
    });
  }

  // -----------------------------------------------------------------------
  // Hire (sync)
  // -----------------------------------------------------------------------

  async hire(req: HireRequest): Promise<HireResponse> {
    if (this.budgetState) assertCanSpend(this.budgetState, req.max_price_usdc);

    // Resolve target seller endpoint:
    //   - explicit endpoint provided -> use it
    //   - else search by capability (filtered by agent_id if provided)
    let sellerId = req.agent_id;
    let endpoint = req.endpoint;
    if (!endpoint) {
      const candidates = await this.search({
        capability: req.capability,
        max_price_usdc: req.max_price_usdc,
        max_latency_ms: req.max_latency_ms,
        limit: sellerId ? 50 : 1,
      });
      const top = sellerId
        ? candidates.find((c) => c.agent_id === sellerId)
        : candidates[0];
      if (!top) {
        throw new HireRefusedError(
          sellerId
            ? `Agent ${sellerId} has no listing for ${req.capability}`
            : `No agents found for capability ${req.capability}`,
        );
      }
      sellerId = top.agent_id;
      endpoint = top.listing.endpoint;
    }

    // Anti-hijack: validate that the seller's x402 challenge demands payment
    // to the resolved sellerId. Refuse to sign if the endpoint is serving a
    // different agent than the listing claims.
    const validateSeller = req.validateSeller !== false;
    if (validateSeller && !sellerId) {
      throw new SellerMismatchError(
        "(unknown — agent_id required when endpoint is set and validateSeller is true)",
        "(any)",
      );
    }
    const paidFetchForHire = validateSeller && sellerId
      ? (wrapFetchWithPayment(
          globalThis.fetch,
          this.walletClient as Parameters<typeof wrapFetchWithPayment>[1],
          undefined,
          makeAntiHijackSelector(sellerId, this.network),
        ) as unknown as typeof fetch)
      : undefined;

    const nonce = req.nonce ?? crypto.randomUUID();
    const body = {
      protocol: PROTOCOL_VERSION,
      buyer_id: this.agentId,
      capability: req.capability,
      params: req.params,
      max_price_usdc: req.max_price_usdc,
      max_latency_ms: req.max_latency_ms,
      budget_token: req.budget_token ?? this.budgetState?.token,
      callback_url: null,
      nonce,
    };

    this.telemetry.send({
      kind: "hire_attempt",
      capability: req.capability,
      seller_id: sellerId ?? null,
    });

    const t0 = Date.now();
    let response: HireResponse;
    let txHashFromHeader: string | undefined;
    try {
      response = await this.transport.json<HireResponse>(`${endpoint}/hire`, {
        method: "POST",
        body: JSON.stringify(body),
        paid: true,
        paidFetch: paidFetchForHire,
        onResponse: (res) => {
          txHashFromHeader = decodeX402SettlementTxHash(res);
        },
      });
    } catch (err) {
      this.telemetry.send({
        kind: "hire_failed",
        capability: req.capability,
        reason: (err as Error).message,
      });
      throw err;
    }

    if (response.protocol !== PROTOCOL_VERSION) {
      throw new InvalidProtocolVersionError(response.protocol, PROTOCOL_VERSION);
    }

    // x402-hono sets X-PAYMENT-RESPONSE on the response after the seller
    // handler has already serialized its body, so the receipt body's
    // `tx_hash` arrives as zeroed-out. Recover the real settlement hash
    // from the header and patch the receipt before returning.
    if (
      txHashFromHeader &&
      response.receipt &&
      isZeroHash(response.receipt.tx_hash)
    ) {
      response.receipt.tx_hash = txHashFromHeader as typeof response.receipt.tx_hash;
    }

    // Run client-side verification
    const verification = verify(req.capability, req.params, response.result);
    if (!verification.all_passed) {
      throw new VerificationFailedError(
        verification.checks.filter((c) => !c.passed),
      );
    }

    if (this.budgetState) recordSpend(this.budgetState, response.receipt.price_paid_usdc);

    this.telemetry.send({
      kind: "hire_complete",
      capability: req.capability,
      seller_id: response.receipt.seller_id,
      price_usdc: response.receipt.price_paid_usdc,
      latency_ms: Date.now() - t0,
      all_passed: true,
    });

    return response;
  }

  // -----------------------------------------------------------------------
  // Hire (async)
  // -----------------------------------------------------------------------

  async hireAsync(
    req: HireRequest & { callback_url: string },
  ): Promise<AsyncHireResponse> {
    if (this.budgetState) assertCanSpend(this.budgetState, req.max_price_usdc);

    if (!req.agent_id) {
      throw new HireRefusedError(
        "Async hire requires an explicit agent_id (use search() first)",
      );
    }
    const rep = await this.getReputation(req.agent_id);
    const endpoint = (rep as unknown as { endpoint?: string }).endpoint;
    if (!endpoint) {
      throw new HireRefusedError(`No endpoint for agent ${req.agent_id}`);
    }

    return this.transport.json<AsyncHireResponse>(`${endpoint}/hire`, {
      method: "POST",
      body: JSON.stringify({
        protocol: PROTOCOL_VERSION,
        buyer_id: this.agentId,
        capability: req.capability,
        params: req.params,
        max_price_usdc: req.max_price_usdc,
        max_latency_ms: req.max_latency_ms,
        budget_token: req.budget_token ?? this.budgetState?.token,
        callback_url: req.callback_url,
        nonce: req.nonce ?? crypto.randomUUID(),
      }),
      paid: true,
    });
  }

  async getJob(endpoint: string, jobId: string): Promise<JobStatus> {
    return this.transport.json<JobStatus>(`${endpoint}/jobs/${jobId}`, {
      method: "GET",
    });
  }

  // -----------------------------------------------------------------------
  // Rating
  // -----------------------------------------------------------------------

  async rate(
    rating_token: string,
    opts: { stars: Stars; latency_ms?: number; comment?: string },
  ): Promise<void> {
    const body: RatingRequest = {
      rating_token,
      stars: opts.stars,
      latency_ms: opts.latency_ms,
      comment: opts.comment,
    };
    await this.transport.json("/v1/rate", {
      method: "POST",
      body: JSON.stringify(body),
    });
    this.telemetry.send({ kind: "rate", stars: opts.stars });
  }

  // -----------------------------------------------------------------------
  // Listings (for sellers)
  // -----------------------------------------------------------------------

  async publishListing(
    listing: Omit<Listing, "agent_id" | "signature">,
  ): Promise<Listing> {
    const partial = { ...listing, agent_id: this.agentId };
    const signature = await this.wallet.signTypedPayload(partial);
    const signed: Listing = { ...partial, signature };
    await this.transport.json("/v1/listings", {
      method: "POST",
      body: JSON.stringify(signed),
    });
    return signed;
  }
}

const ZERO_HASH =
  "0x0000000000000000000000000000000000000000000000000000000000000000";

function isZeroHash(h: string | undefined | null): boolean {
  return !h || h === ZERO_HASH || h === "0x" || h === "";
}

/**
 * Build an x402 PaymentRequirementsSelector that accepts a payment requirement
 * only if its `payTo` matches the buyer's expected sellerId. Used by
 * `AgentClient.hire` to guard against endpoint hijacks and stale listings.
 *
 * Throws `SellerMismatchError` BEFORE any signature is created, so funds
 * remain safe.
 */
function makeAntiHijackSelector(
  expectedSellerId: AgentId,
  network: SwarmwageNetwork,
): PaymentRequirementsSelector {
  const expected = expectedSellerId.toLowerCase();
  return (paymentRequirements, _network, scheme) => {
    // Force-narrow to our network. Otherwise an attacker could include a
    // requirement on a different chain where the buyer happens to have funds.
    const selected = selectPaymentRequirements(
      paymentRequirements,
      network,
      scheme,
    );
    const actual = (selected.payTo ?? "").toLowerCase();
    if (actual !== expected) {
      throw new SellerMismatchError(expected, actual || "(missing)");
    }
    return selected;
  };
}

function decodeX402SettlementTxHash(res: Response): string | undefined {
  const xpr = res.headers.get("X-PAYMENT-RESPONSE");
  if (!xpr) return undefined;
  try {
    const decoded = JSON.parse(
      typeof atob === "function"
        ? atob(xpr)
        : Buffer.from(xpr, "base64").toString("utf8"),
    ) as { transaction?: string; txHash?: string };
    return decoded.transaction ?? decoded.txHash ?? undefined;
  } catch {
    return undefined;
  }
}
