// Swarmwage Agent SDK — main AgentClient
// License: MIT

import { Transport, type PaymentSigner, type X402Challenge } from "./transport.js";
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

export interface AgentClientOptions extends WalletConfig {
  /** Override the canonical registry URL. */
  registryUrl?: string;
  /** Pre-authorized budget from the human operator. */
  budget?: BudgetToken;
  /** Force telemetry on/off. Defaults to env var `AGENT_TELEMETRY`. */
  telemetry?: boolean;
}

export class AgentClient {
  readonly wallet: AgentWallet;
  readonly registryUrl: string;
  private budgetState: BudgetState | null;
  private readonly transport: Transport;
  private readonly telemetry: ReturnType<typeof createTelemetry>;

  constructor(opts: AgentClientOptions) {
    this.wallet = createWallet({ privateKey: opts.privateKey });
    this.registryUrl = opts.registryUrl ?? "https://api.swarmwage.com";
    this.budgetState = opts.budget ? createBudgetState(opts.budget) : null;
    this.transport = new Transport({ baseUrl: this.registryUrl });
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

    // Resolve target seller — search if not specified.
    let sellerId = req.agent_id;
    let endpoint: string | undefined;
    if (!sellerId) {
      const candidates = await this.search({
        capability: req.capability,
        max_price_usdc: req.max_price_usdc,
        max_latency_ms: req.max_latency_ms,
        limit: 1,
      });
      const top = candidates[0];
      if (!top) {
        throw new HireRefusedError(`No agents found for capability ${req.capability}`);
      }
      sellerId = top.agent_id;
      endpoint = top.listing.endpoint;
    } else {
      // Look up endpoint via reputation lookup
      const rep = await this.getReputation(sellerId);
      // SearchResultEntry would be cleaner; for v0.0.1 we require explicit endpoint
      // when the agent_id is given without a prior search.
      endpoint = (rep as unknown as { endpoint?: string }).endpoint;
      if (!endpoint) {
        throw new HireRefusedError(
          `No endpoint for agent ${sellerId}; use search() to obtain a listing first`,
        );
      }
    }

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
      seller_id: sellerId,
    });

    const t0 = Date.now();
    let response: HireResponse;
    try {
      response = await this.transport.json<HireResponse>(`${endpoint}/hire`, {
        method: "POST",
        body: JSON.stringify(body),
        paymentSigner: this.makePaymentSigner(),
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
      paymentSigner: this.makePaymentSigner(),
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

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  private makePaymentSigner(): PaymentSigner {
    return {
      signPayment: async (challenge: X402Challenge) => {
        // v0.0.1: produce a signed authorization message; the actual on-chain
        // payment broadcast is handled by the seller's escrow contract on settlement.
        // Full x402 flow integration lands in v0.0.2.
        const message = JSON.stringify({
          x402: "v1",
          network: challenge.network,
          to: challenge.address,
          amount: challenge.amount,
          capability_hash: challenge.capability_hash,
          buyer: this.agentId,
          ts: Date.now(),
        });
        const signature = await this.wallet.signMessage(message);
        return `${signature}.${btoa(message)}`;
      },
    };
  }
}
