# Swarmwage Agent SDK (Python) — error types
# Mirrors packages/sdk-ts/src/errors.ts for code-level parity
# License: MIT

from __future__ import annotations


class SwarmwageError(Exception):
    """Base class for every error raised by the SDK."""

    code: str = "SWARMWAGE_ERROR"

    def __init__(self, message: str, *, cause: BaseException | None = None) -> None:
        super().__init__(message)
        if cause is not None:
            self.__cause__ = cause


class TransportError(SwarmwageError):
    code = "TRANSPORT_ERROR"

    def __init__(
        self,
        message: str,
        status: int | None = None,
        *,
        cause: BaseException | None = None,
    ) -> None:
        super().__init__(message, cause=cause)
        self.status = status


class BudgetExceededError(SwarmwageError):
    code = "BUDGET_EXCEEDED"

    def __init__(self, requested_usdc: str, remaining_usdc: str) -> None:
        super().__init__(
            f"Hire price {requested_usdc} USDC exceeds remaining budget {remaining_usdc} USDC"
        )
        self.requested_usdc = requested_usdc
        self.remaining_usdc = remaining_usdc


class BudgetExpiredError(SwarmwageError):
    code = "BUDGET_EXPIRED"

    def __init__(self) -> None:
        super().__init__("Budget token has expired")


class VerificationFailedError(SwarmwageError):
    code = "VERIFICATION_FAILED"

    def __init__(self, checks: list[dict[str, str]]) -> None:
        names = ", ".join(c.get("name", "") for c in checks)
        super().__init__(
            f"Output failed {len(checks)} verification check(s): {names}"
        )
        self.checks = checks


class HireRefusedError(SwarmwageError):
    code = "HIRE_REFUSED"

    def __init__(self, message: str, seller_message: str | None = None) -> None:
        super().__init__(message)
        self.seller_message = seller_message


class InvalidProtocolVersionError(SwarmwageError):
    code = "INVALID_PROTOCOL_VERSION"

    def __init__(self, received: str, expected: str) -> None:
        super().__init__(f"Expected protocol {expected}, received {received}")
        self.received = received
        self.expected = expected


class PaymentFailedError(SwarmwageError):
    code = "PAYMENT_FAILED"

    def __init__(self, message: str, *, cause: BaseException | None = None) -> None:
        super().__init__(message, cause=cause)


class InsufficientFundsError(SwarmwageError):
    """Raised when a hire ultimately fails because the buyer wallet does
    not hold enough USDC on the target chain.

    Carries the bits a calling agent (or MCP wrapper) needs to guide the
    user to fund the wallet rather than fall back to a competing service.
    """

    code = "INSUFFICIENT_FUNDS"

    def __init__(
        self,
        agent_id: str,
        required_usdc: str,
        chain: str,
        seller_id: str | None = None,
        *,
        cause: BaseException | None = None,
    ) -> None:
        super().__init__(
            f"Hire failed: wallet {agent_id} cannot settle {required_usdc} USDC on {chain}. "
            f"Fund the wallet at https://www.coinbase.com/ or any USDC-on-{chain} on-ramp, "
            "then retry the same hire.",
            cause=cause,
        )
        self.agent_id = agent_id
        self.required_usdc = required_usdc
        self.chain = chain
        self.seller_id = seller_id


class SellerMismatchError(SwarmwageError):
    """Raised when the seller's x402 challenge demands payment to an
    address that does not match the agent_id the buyer intended to hire.

    The SDK throws this BEFORE any payment is signed, so funds are safe.
    """

    code = "SELLER_MISMATCH"

    def __init__(self, expected: str, actual: str) -> None:
        super().__init__(
            f"Seller payTo mismatch: expected {expected}, server demanded payment "
            f"to {actual}. Endpoint may be hijacked or listing is stale. "
            "Refusing to sign payment."
        )
        self.expected = expected
        self.actual = actual


__all__ = [
    "SwarmwageError",
    "TransportError",
    "BudgetExceededError",
    "BudgetExpiredError",
    "VerificationFailedError",
    "HireRefusedError",
    "InvalidProtocolVersionError",
    "PaymentFailedError",
    "InsufficientFundsError",
    "SellerMismatchError",
]
