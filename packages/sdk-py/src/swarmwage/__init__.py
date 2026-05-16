# Swarmwage Agent SDK (Python) — public exports
# Spec: https://github.com/Swarmwage/swarmwage/blob/main/packages/protocol/SPEC.md
# License: MIT

from ._payment import (
    SWARMWAGE_FACILITATOR_HEADER,
    SWARMWAGE_FACILITATOR_URL,
    resolve_facilitator_url,
)
from ._signing import (
    canonical_typed_payload,
    hash_typed_payload,
    sign_typed_payload,
)
from .client import AgentClient
from .endpoint_verify import ENDPOINT_VERIFY_PATH, sign_endpoint_verify
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
from .receipts import (
    DEFAULT_REGISTRY_URL,
    ReceiptPayload,
    SubmitReceiptResult,
    is_receipts_enabled,
    sign_receipt,
    submit_receipt,
)
from .telemetry import DEFAULT_TELEMETRY_URL, Telemetry
from .verification import register_verifier, verify as verify_capability
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

__version__ = "0.3.0a0"

__all__ = [
    "__version__",
    "PROTOCOL_VERSION",
    "AgentClient",
    "Telemetry",
    "DEFAULT_TELEMETRY_URL",
    "DEFAULT_REGISTRY_URL",
    "SWARMWAGE_FACILITATOR_URL",
    "SWARMWAGE_FACILITATOR_HEADER",
    "resolve_facilitator_url",
    "verify_capability",
    "register_verifier",
    # canonical signing primitives
    "canonical_typed_payload",
    "hash_typed_payload",
    "sign_typed_payload",
    # seller-side
    "ReceiptPayload",
    "SubmitReceiptResult",
    "is_receipts_enabled",
    "sign_receipt",
    "submit_receipt",
    "ENDPOINT_VERIFY_PATH",
    "sign_endpoint_verify",
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
