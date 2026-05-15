# Swarmwage Agent SDK (Python) — public exports
# Spec: https://github.com/Swarmwage/swarmwage/blob/main/packages/protocol/SPEC.md
# License: MIT

from .client import AgentClient
from .errors import (
    BudgetExceededError,
    BudgetExpiredError,
    HireRefusedError,
    InsufficientFundsError,
    InvalidProtocolVersionError,
    PaymentFailedError,
    SellerMismatchError,
    SwarmwageError,
    TransportError,
    VerificationFailedError,
)
from .telemetry import DEFAULT_TELEMETRY_URL, Telemetry
from .types import (
    PROTOCOL_VERSION,
    AsyncHireResponse,
    BudgetToken,
    HireRequest,
    HireResponse,
    JobStatus,
    Listing,
    RatingRequest,
    Receipt,
    Reputation,
    SearchRequest,
    SearchResponse,
    SearchResultEntry,
    Stars,
    SubmittedReceipt,
    VerificationCheck,
    VerificationResult,
)

__version__ = "0.1.0a0"

__all__ = [
    "__version__",
    "PROTOCOL_VERSION",
    "AgentClient",
    "Telemetry",
    "DEFAULT_TELEMETRY_URL",
    # protocol models
    "Listing",
    "Reputation",
    "SearchRequest",
    "SearchResponse",
    "SearchResultEntry",
    "BudgetToken",
    "HireRequest",
    "HireResponse",
    "AsyncHireResponse",
    "JobStatus",
    "Receipt",
    "VerificationCheck",
    "VerificationResult",
    "RatingRequest",
    "Stars",
    "SubmittedReceipt",
    # errors
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
