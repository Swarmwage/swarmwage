// Swarmwage Agent SDK — main AgentClient
// License: MIT

import { createHash } from "node:crypto";

import { buildPaidFetch, decodeSettlement } from "./x402.js";
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
import { resolveFacilitatorUrl } from "./facilitator.js";
import { isReliabilityEnabled } from "./reliability.js";
import { verify } from "./verification.js";
import {
  HireRefusedError,
  InsufficientFundsError,
  InvalidProtocolVersionError,
  SellerMismatchError,
  TransportError,
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
  type PayX402Request,
  type PayX402Response,
  type ExternalX402ReliabilityQuery,
  type ExternalX402ReliabilityResponse,
  type Listing,
  type RatingRequest,
  type Reputation,
  type SearchRequest,
  type SearchResponse,
  type SearchResultEntry,
  type Stars,
  type SubmittedReceipt,
  type UsdcAmount,
} from "./types.js";

export type SwarmwageNetwork = "base" | "base-sepolia";

// USDC has 6 decimals on Base; convert a decimal string ("0.50") to atomic
// units (500_000n). Rounds up on the last decimal so a buyer who set the cap
// to "0.50" doesn't get tripped by floating-point representation of the
// seller's price.
function usdcStringToAtomic(amount: string): bigint {
  const [intPart, fracRaw = ""] = amount.split(".");
  const frac = (fracRaw + "000000").slice(0, 6);
  const combined = `${intPart}${frac}`.replace(/^0+(?=\d)/, "");
  return BigInt(combined === "" ? "0" : combined);
}

// Inverse of usdcStringToAtomic: atomic USDC units (6 decimals) -> decimal
// string. "0.020000" trailing zeros are trimmed ("0.02"); a whole-dollar
// amount renders without a fractional part ("1"). Used to book the actual
// amount paid on a raw x402 call against the operator budget.
function atomicToUsdcString(atomic: bigint): string {
  const s = atomic.toString().padStart(7, "0");
  const intPart = s.slice(0, -6).replace(/^0+(?=\d)/, "");
  const frac = s.slice(-6).replace(/0+$/, "");
  return frac ? `${intPart}.${frac}` : intPart;
}

function externalX402TelemetryMeta(req: PayX402Request, method: string) {
  return {
    url: req.url,
    method,
    max_price_usdc: req.max_price_usdc,
    source: req.source,
    service_id: req.service_id,
    service_name: req.service_name,
    endpoint_description: req.endpoint_description,
    category: req.category,
    pricing_scheme: req.pricing_scheme,
  };
}

function stableJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const entries = Object.keys(obj)
      .filter((key) => obj[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(obj[key])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(String(value));
}

function sha256Hex(value: unknown): `0x${string}` {
  return `0x${createHash("sha256").update(stableJson(value)).digest("hex")}`;
}

// Used for the default (non-hire) paidFetch that the AgentClient instantiates
// at construction. The constructor doesn't know per-call price caps, so we
// pick a generous default (10 USDC = 10_000_000 atomic) — high enough not to
// shadow any sane price, but still bounded so a runaway seller can't drain
// the wallet on a single accidental call.
const DEFAULT_PAID_FETCH_MAX_VALUE_ATOMIC = 10_000_000n;

export interface AgentClientOptions extends WalletConfig {
  /** Override the canonical registry URL. */
  registryUrl?: string;
  /** Pre-authorized budget from the human operator. */
  budget?: BudgetToken;
  /** Force telemetry on/off. Defaults to env var `AGENT_TELEMETRY`. */
  telemetry?: boolean;
  /** Force external x402 reliability submission on/off. Defaults to env var `SWARMWAGE_RELIABILITY`. */
  reliability?: boolean;
  /**
   * Chain to use for x402 payments. Defaults to `"base"` (Base mainnet),
   * matching the production network where Swarmwage is live. Pass
   * `"base-sepolia"` explicitly to target the Base Sepolia testnet for
   * development or integration testing.
   */
  network?: SwarmwageNetwork;
  /** Override the JSON-RPC URL. Defaults to viem's public RPC for the network. */
  rpcUrl?: string;
  /**
   * x402 facilitator URL advertised to sellers on every paid request.
   *
   * - `undefined` (default): use `https://facilitator.swarmwage.com` unless
   *   env `SWARMWAGE_FACILITATOR` is set to `0`/`false`/`off`/`no`.
   * - `null`: opt out — the seller uses its own facilitator from the 402
   *   challenge.
   * - non-empty string: use this URL instead of the default.
   *
   * The Swarmwage Facilitator is a gas-relay-only x402 service: it pays ETH
   * to invoke `USDC.transferWithAuthorization()` on behalf of the buyer.
   * Funds move directly from buyer to seller — the facilitator never
   * custodies USDC.
   */
  facilitatorUrl?: string | null;
}

export class AgentClient {
  readonly wallet: AgentWallet;
  readonly registryUrl: string;
  readonly network: SwarmwageNetwork;
  /**
   * Resolved facilitator URL advertised on paid requests, or `null` when the
   * SDK falls back to the seller's facilitator. Read-only; set at construct
   * time from `opts.facilitatorUrl` and the env.
   */
  readonly facilitatorUrl: string | null;
  private budgetState: BudgetState | null;
  private readonly transport: Transport;
  private readonly telemetry: ReturnType<typeof createTelemetry>;
  private readonly reliabilityEnabled: boolean;

  constructor(opts: AgentClientOptions) {
    this.wallet = createWallet({ privateKey: opts.privateKey });
    this.registryUrl = opts.registryUrl ?? "https://api.swarmwage.com";
    this.network = opts.network ?? "base";
    this.facilitatorUrl = resolveFacilitatorUrl({
      facilitatorUrl: opts.facilitatorUrl,
    });

    // Default-tier paidFetch (used outside hire(), e.g. for /v1/listings etc.)
    // — gets a high default cap so it doesn't bottleneck a priced call. No
    // anti-hijack here (not a hire). Per-hire/per-call paidFetch is built
    // inside hire()/payX402() with the caller's actual max_price_usdc as cap.
    const paidFetch = buildPaidFetch({
      account: this.wallet.account,
      network: this.network,
      maxValueAtomic: DEFAULT_PAID_FETCH_MAX_VALUE_ATOMIC,
      facilitatorUrl: this.facilitatorUrl,
    });

    this.budgetState = opts.budget ? createBudgetState(opts.budget) : null;
    this.transport = new Transport({
      baseUrl: this.registryUrl,
      paidFetch,
      facilitatorUrl: this.facilitatorUrl,
    });
    this.telemetry = createTelemetry({
      enabled: opts.telemetry,
      agentId: this.wallet.agentId,
    });
    this.reliabilityEnabled = isReliabilityEnabled(opts.reliability);
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

  async getExternalX402Reliability(
    opts: ExternalX402ReliabilityQuery = {},
  ): Promise<ExternalX402ReliabilityResponse> {
    const params = new URLSearchParams();
    if (opts.limit !== undefined) params.set("limit", String(opts.limit));
    if (opts.source) params.set("source", opts.source);
    if (opts.service_id) params.set("service_id", opts.service_id);
    if (opts.url) params.set("url", opts.url);
    const qs = params.toString();
    return this.transport.json<ExternalX402ReliabilityResponse>(
      `/v1/reliability/external-x402${qs ? `?${qs}` : ""}`,
      { method: "GET" },
    );
  }

  // -----------------------------------------------------------------------
  // Hire (sync)
  // -----------------------------------------------------------------------

  async hire(req: HireRequest): Promise<HireResponse> {
    if (this.budgetState) assertCanSpend(this.budgetState, req.max_price_usdc);

    // "Free-hire intent" pattern: caller passes max_price_usdc="0" because
    // their budget is empty and they want only first_call_free listings.
    // Without this branch the search filter would exclude every listing
    // (since free-tier listings still advertise a positive price_usdc that
    // applies AFTER the first call), so the hire would fail with "no agents
    // found" — a misleading error since the agent exists, it's just priced
    // above the filter. Drop the price filter and enforce free-tier
    // client-side on the chosen listing.
    const wantsFreeHire = parseFloat(req.max_price_usdc) === 0;

    // Resolve target seller endpoint:
    //   - explicit endpoint provided -> use it
    //   - else search by capability (filtered by agent_id if provided)
    let sellerId = req.agent_id;
    let endpoint = req.endpoint;
    if (!endpoint) {
      const candidates = await this.search({
        capability: req.capability,
        max_price_usdc: wantsFreeHire ? undefined : req.max_price_usdc,
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
      // If the caller signaled free-hire intent but the cheapest match is
      // not first_call_free, surface the actual price instead of letting
      // the x402 challenge silently consume budget the caller doesn't have.
      if (wantsFreeHire && !top.listing.first_call_free) {
        throw new HireRefusedError(
          `No free-tier agent for ${req.capability}. Cheapest live listing is ${top.listing.price_usdc} USDC — pass max_price_usdc='${top.listing.price_usdc}' (or higher) to proceed with a paid hire.`,
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
    // The caller's max_price_usdc becomes the hard spend cap. Anti-hijack is
    // enforced by passing expectedSellerId: the payment selector refuses to
    // sign unless the seller's 402 challenge pays out to the resolved sellerId.
    const hireMaxValueAtomic = usdcStringToAtomic(req.max_price_usdc);
    // The payment selector throws SellerMismatchError on a payTo mismatch, but
    // @x402/fetch re-wraps it as a generic error; capture the structured one
    // here so we can restore it after the transport call.
    let paymentRejection: Error | undefined;
    const paidFetchForHire = validateSeller && sellerId
      ? buildPaidFetch({
          account: this.wallet.account,
          network: this.network,
          maxValueAtomic: hireMaxValueAtomic,
          expectedSellerId: sellerId,
          facilitatorUrl: this.facilitatorUrl,
          onReject: (e) => {
            paymentRejection = e;
          },
        })
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
          txHashFromHeader = decodeSettlement(res).txHash;
        },
      });
    } catch (err) {
      this.telemetry.send({
        kind: "hire_failed",
        capability: req.capability,
        reason: (err as Error).message,
      });
      // Restore the typed error the selector raised (e.g. SellerMismatchError),
      // which @x402/fetch wrapped into a generic payment-creation error.
      if (paymentRejection) {
        throw paymentRejection;
      }
      // x402 settlement failure after the EIP-3009 retry surfaces as a
      // second HTTP 402 from the seller. Re-throw as a typed error so the
      // calling agent (or MCP wrapper) can guide the user to fund the
      // wallet rather than fall back to a competing service.
      if (err instanceof TransportError && err.status === 402) {
        throw new InsufficientFundsError(
          this.agentId,
          req.max_price_usdc,
          this.network,
          sellerId,
          err,
        );
      }
      throw err;
    }

    // Budget accounting happens as soon as the response arrives: the x402
    // payment settled on-chain during the transport's 402 retry, so the
    // spend is real even if the protocol or verification checks below throw.
    // Recording after the verification gate (as before) let a seller that
    // systematically fails verification drain the wallet past the
    // operator-authorized budget.
    if (this.budgetState && response.receipt?.price_paid_usdc) {
      recordSpend(this.budgetState, response.receipt.price_paid_usdc);
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
  // Raw x402 call (external endpoints, outside the Swarmwage hire envelope)
  // -----------------------------------------------------------------------

  /**
   * Call an arbitrary x402-enabled endpoint and pay for it from this agent's
   * wallet. Unlike `hire()`, this makes NO assumption that the target is a
   * Swarmwage-protocol seller: it sends the service's own native request shape
   * to the URL as-is and returns the raw response, handling the x402 402 →
   * signed-authorization → retry dance transparently.
   *
   * Safety posture:
   *  - Payment is capped at `max_price_usdc` (default "1.00"); the SDK refuses
   *    to sign above the cap.
   *  - Selection is forced onto the configured network, so a multi-network
   *    endpoint can't trick the wallet into paying on a chain where it holds
   *    other funds.
   *  - The Swarmwage facilitator is advertised (header + requirement hint) so
   *    the call still flows through our gas-relay when the endpoint honours it.
   *
   * There is NO seller-identity (anti-hijack) check: the endpoint is an
   * external third party, not a registered Swarmwage agent. The price cap is
   * the safety bound. Budget (when loaded) is debited by the amount actually
   * required by the selected 402 challenge.
   */
  async payX402(req: PayX402Request): Promise<PayX402Response> {
    const maxPrice = req.max_price_usdc ?? "1.00";
    if (this.budgetState) assertCanSpend(this.budgetState, maxPrice);

    // Capture the amount the selected requirement demands (estimate) so budget
    // accounting reflects what was actually paid (not the cap). onSelected runs
    // only when the endpoint issues a 402 — a free/already-paid 200 leaves this
    // undefined and books no spend. The actual settled amount from the
    // settlement header (when present) takes precedence below.
    let estimatedAtomic: bigint | undefined;
    const paidFetch = buildPaidFetch({
      account: this.wallet.account,
      network: this.network,
      maxValueAtomic: usdcStringToAtomic(maxPrice),
      facilitatorUrl: this.facilitatorUrl,
      onSelected: (atomic) => {
        estimatedAtomic = atomic;
      },
    });

    const method = req.method ?? (req.body !== undefined ? "POST" : "GET");
    const telemetryMeta = externalX402TelemetryMeta(req, method);
    this.telemetry.send({ kind: "x402_call", ...telemetryMeta });

    const t0 = Date.now();
    let status = 0;
    let txHash: string | undefined;
    let settledAtomic: bigint | undefined;
    let data: unknown;
    const requestHash =
      req.body !== undefined ? sha256Hex(req.body) : undefined;
    try {
      data = await this.transport.json<unknown>(req.url, {
        method,
        body: req.body !== undefined ? JSON.stringify(req.body) : undefined,
        headers: req.headers,
        paid: true,
        paidFetch,
        onResponse: (res) => {
          status = res.status;
          const settlement = decodeSettlement(res);
          txHash = settlement.txHash;
          settledAtomic = settlement.amountAtomic;
        },
      });
    } catch (err) {
      const latencyMs = Date.now() - t0;
      this.telemetry.send({
        kind: "x402_call_failed",
        ...telemetryMeta,
        reason: (err as Error).message,
      });
      await this.submitExternalX402ReliabilityRecord({
        ...telemetryMeta,
        buyer_agent_id: this.agentId,
        status: err instanceof TransportError && err.status ? err.status : 0,
        latency_ms: latencyMs,
        request_hash: requestHash,
        response_hash: sha256Hex({ error: (err as Error).message }),
        verifier_kind: "none",
        verifier_status: "unknown",
        verifier_checks: {},
        error: (err as Error).message,
      });
      // A second 402 after the EIP-3009 retry means settlement failed —
      // surface it as InsufficientFunds so the caller can guide funding.
      if (err instanceof TransportError && err.status === 402) {
        throw new InsufficientFundsError(
          this.agentId,
          maxPrice,
          this.network,
          undefined,
          err,
        );
      }
      throw err;
    }

    // Prefer the actual settled amount from the settlement header; fall back to
    // the requirement estimate captured during selection.
    const billedAtomic = settledAtomic ?? estimatedAtomic;
    const amountPaid =
      billedAtomic !== undefined ? atomicToUsdcString(billedAtomic) : undefined;
    if (this.budgetState && amountPaid) {
      recordSpend(this.budgetState, amountPaid);
    }

    const latencyMs = Date.now() - t0;
    const responseHash = sha256Hex(data);
    const reliabilityRecordId = await this.submitExternalX402ReliabilityRecord({
      ...telemetryMeta,
      buyer_agent_id: this.agentId,
      status,
      amount_paid_usdc: amountPaid,
      tx_hash: txHash as PayX402Response["tx_hash"],
      latency_ms: latencyMs,
      request_hash: requestHash,
      response_hash: responseHash,
      verifier_kind: "none",
      verifier_status: "unknown",
      verifier_checks: {},
    });

    this.telemetry.send({
      kind: "x402_call_complete",
      ...telemetryMeta,
      amount_usdc: amountPaid ?? null,
      latency_ms: latencyMs,
      status,
      tx_hash: txHash,
      reliability_record_id: reliabilityRecordId,
    });

    return {
      url: req.url,
      status,
      data,
      tx_hash: txHash as PayX402Response["tx_hash"],
      amount_paid_usdc: amountPaid,
      reliability_record_id: reliabilityRecordId,
      request_hash: requestHash,
      response_hash: responseHash,
      latency_ms: latencyMs,
    };
  }

  private async submitExternalX402ReliabilityRecord(record: {
    buyer_agent_id: AgentId;
    source?: string;
    service_id?: string;
    service_name?: string;
    endpoint_description?: string;
    category?: string;
    pricing_scheme?: string;
    url: string;
    method: string;
    status: number;
    amount_paid_usdc?: string;
    tx_hash?: PayX402Response["tx_hash"];
    latency_ms: number;
    request_hash?: `0x${string}`;
    response_hash: `0x${string}`;
    verifier_kind: "none" | "json" | "custom";
    verifier_status: "unknown" | "pass" | "fail";
    verifier_checks: Record<string, boolean>;
    error?: string;
  }): Promise<string | undefined> {
    if (!this.reliabilityEnabled) return undefined;
    try {
      const res = await this.transport.json<{ reliability_record_id?: string }>(
        "/v1/reliability/external-x402",
        {
          method: "POST",
          body: JSON.stringify({
            ts: Date.now(),
            trust_level: "client_observed",
            ...record,
          }),
        },
      );
      return res.reliability_record_id;
    } catch {
      return undefined;
    }
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
    // Resolve the seller endpoint from their active listings. The reputation
    // response carries no endpoint — only listings do — so we look up the
    // listing that matches the requested capability.
    const { listings } = await this.transport.json<{ listings: Listing[] }>(
      `/v1/agents/${req.agent_id}/listings`,
      { method: "GET" },
    );
    const listing = listings.find((l) => l.capability === req.capability);
    if (!listing) {
      throw new HireRefusedError(
        `Agent ${req.agent_id} has no listing for ${req.capability}`,
      );
    }
    const endpoint = listing.endpoint;

    // Same anti-hijack + price-cap posture as the sync hire() path: the
    // payment selector refuses to sign unless the seller's 402 challenge
    // pays out to the agent_id we resolved the listing from.
    let paymentRejection: Error | undefined;
    const paidFetchForAsyncHire = buildPaidFetch({
      account: this.wallet.account,
      network: this.network,
      maxValueAtomic: usdcStringToAtomic(req.max_price_usdc),
      expectedSellerId: req.agent_id,
      facilitatorUrl: this.facilitatorUrl,
      onReject: (e) => {
        paymentRejection = e;
      },
    });

    try {
      return await this.transport.json<AsyncHireResponse>(`${endpoint}/hire`, {
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
        paidFetch: paidFetchForAsyncHire,
      });
    } catch (err) {
      // Restore the typed selector error (e.g. SellerMismatchError) wrapped by
      // @x402/fetch into a generic payment-creation error.
      if (paymentRejection) {
        throw paymentRejection;
      }
      throw err;
    }
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

  /**
   * List the active listings this client's wallet has published. Read-only —
   * no signature required because the on-chain agent_id is public anyway.
   */
  async getMyListings(): Promise<Listing[]> {
    const res = await this.transport.json<{ listings: Listing[] }>(
      `/v1/agents/${this.agentId}/listings`,
      { method: "GET" },
    );
    return res.listings;
  }

  /**
   * Recent receipts submitted by this client's wallet (seller-side view).
   * `limit` defaults to 50 on the registry side and is capped at 200.
   */
  async getMyReceipts(opts: { limit?: number } = {}): Promise<SubmittedReceipt[]> {
    const qs = opts.limit !== undefined ? `?limit=${opts.limit}` : "";
    const res = await this.transport.json<{ receipts: SubmittedReceipt[] }>(
      `/v1/agents/${this.agentId}/receipts${qs}`,
      { method: "GET" },
    );
    return res.receipts;
  }
}

const ZERO_HASH =
  "0x0000000000000000000000000000000000000000000000000000000000000000";

function isZeroHash(h: string | undefined | null): boolean {
  return !h || h === ZERO_HASH || h === "0x" || h === "";
}

// Payment-requirement selection (network-force + anti-hijack + spend cap +
// facilitator hint) and settlement decoding now live in ./x402.ts, built on
// the x402 protocol v2 stack (@x402/core + @x402/fetch + @x402/evm).
