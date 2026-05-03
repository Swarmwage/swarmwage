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
