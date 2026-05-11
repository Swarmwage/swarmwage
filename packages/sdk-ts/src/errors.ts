// Swarmwage Agent SDK — error types
// License: MIT

export class SwarmwageError extends Error {
  readonly code: string;
  constructor(code: string, message: string, cause?: unknown) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = "SwarmwageError";
    this.code = code;
  }
}

export class TransportError extends SwarmwageError {
  constructor(
    message: string,
    public readonly status?: number,
    cause?: unknown,
  ) {
    super("TRANSPORT_ERROR", message, cause);
    this.name = "TransportError";
  }
}

export class BudgetExceededError extends SwarmwageError {
  constructor(
    public readonly requested_usdc: string,
    public readonly remaining_usdc: string,
  ) {
    super(
      "BUDGET_EXCEEDED",
      `Hire price ${requested_usdc} USDC exceeds remaining budget ${remaining_usdc} USDC`,
    );
    this.name = "BudgetExceededError";
  }
}

export class BudgetExpiredError extends SwarmwageError {
  constructor() {
    super("BUDGET_EXPIRED", "Budget token has expired");
    this.name = "BudgetExpiredError";
  }
}

export class VerificationFailedError extends SwarmwageError {
  constructor(public readonly checks: { name: string; detail?: string }[]) {
    super(
      "VERIFICATION_FAILED",
      `Output failed ${checks.length} verification check(s): ${checks
        .map((c) => c.name)
        .join(", ")}`,
    );
    this.name = "VerificationFailedError";
  }
}

export class HireRefusedError extends SwarmwageError {
  constructor(message: string, public readonly seller_message?: string) {
    super("HIRE_REFUSED", message);
    this.name = "HireRefusedError";
  }
}

export class InvalidProtocolVersionError extends SwarmwageError {
  constructor(public readonly received: string, public readonly expected: string) {
    super(
      "INVALID_PROTOCOL_VERSION",
      `Expected protocol ${expected}, received ${received}`,
    );
    this.name = "InvalidProtocolVersionError";
  }
}

export class PaymentFailedError extends SwarmwageError {
  constructor(message: string, cause?: unknown) {
    super("PAYMENT_FAILED", message, cause);
    this.name = "PaymentFailedError";
  }
}

/**
 * Raised when an x402 hire ultimately fails settlement — typically because
 * the buyer's wallet does not hold enough USDC on the target chain. The
 * facilitator signs nothing it cannot settle, so this error reaches the
 * SDK as a second 402 after the EIP-3009 retry attempt.
 *
 * Carries the actionable bits a calling agent (or a wrapping MCP server)
 * needs to guide the user to fund their wallet — `agent_id` (deposit
 * address), `required_usdc`, and `chain` — instead of falling back to a
 * competing service.
 */
export class InsufficientFundsError extends SwarmwageError {
  constructor(
    public readonly agent_id: string,
    public readonly required_usdc: string,
    public readonly chain: "base" | "base-sepolia",
    public readonly seller_id?: string,
    cause?: unknown,
  ) {
    super(
      "INSUFFICIENT_FUNDS",
      `Hire failed: wallet ${agent_id} cannot settle ${required_usdc} USDC on ${chain}. ` +
        `Fund the wallet at https://www.coinbase.com/ or any USDC-on-${chain} on-ramp, then retry the same hire.`,
      cause,
    );
    this.name = "InsufficientFundsError";
  }
}

/**
 * Raised when the seller's x402 challenge demands payment to an address that
 * does not match the agent_id the buyer intended to hire.
 *
 * Common causes:
 *   - The seller endpoint has been hijacked (DNS poisoning, expired domain,
 *     compromised host) and is now collecting payments meant for the original
 *     agent.
 *   - The seller operator restarted with a fresh wallet without republishing
 *     their listing — registry has stale `agent_id ↔ endpoint` mapping.
 *   - The buyer was tricked into hiring an agent whose listing endpoint
 *     belongs to a different (malicious) operator.
 *
 * The buyer SDK throws this BEFORE any payment is signed, so funds are safe.
 * To proceed without validation (e.g. for local debugging or known
 * legitimate operator restarts), pass `validateSeller: false` to `hire()`.
 */
export class SellerMismatchError extends SwarmwageError {
  constructor(
    public readonly expected: string,
    public readonly actual: string,
  ) {
    super(
      "SELLER_MISMATCH",
      `Seller payTo mismatch: expected ${expected}, server demanded payment to ${actual}. ` +
        "Endpoint may be hijacked or listing is stale. Refusing to sign payment.",
    );
    this.name = "SellerMismatchError";
  }
}
