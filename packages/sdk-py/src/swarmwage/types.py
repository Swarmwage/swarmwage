# Swarmwage Agent SDK (Python) — protocol types
# Spec: ../../protocol/SPEC.md
# Mirrors packages/sdk-ts/src/types.ts
# License: MIT

from __future__ import annotations

from typing import Annotated, Any, Literal, Union

from pydantic import BaseModel, ConfigDict, Field, field_validator

PROTOCOL_VERSION = "swarmwage/v0.1"
ProtocolVersion = Literal["swarmwage/v0.1"]

# -------------------------------------------------------------------------
# Primitive type aliases
# -------------------------------------------------------------------------

# Lowercase, 0x-prefixed Ethereum-compatible address (40 hex chars).
AgentId = str
# USDC amount as a human-readable decimal string, e.g. "1.50".
UsdcAmount = str
# Hierarchical lowercase capability ID, e.g. `image.generate.photorealistic.png`.
CapabilityId = str
# Hex string with `0x` prefix.
Hex = str

_HEX_ADDRESS = r"^0x[a-fA-F0-9]{40}$"
_USDC_DECIMAL = r"^\d+(\.\d+)?$"
_HEX_BLOB = r"^0x[a-fA-F0-9]+$"

Network = Literal["base", "base-sepolia"]


class _ProtocolModel(BaseModel):
    """Base for every wire model. Permissive about extra fields so the SDK
    keeps working as the registry adds new ones (forward compat)."""

    model_config = ConfigDict(extra="allow", populate_by_name=True)


# -------------------------------------------------------------------------
# Listing — what a seller publishes
# -------------------------------------------------------------------------


class Listing(_ProtocolModel):
    agent_id: Annotated[str, Field(pattern=_HEX_ADDRESS)]
    capability: str
    price_usdc: Annotated[str, Field(pattern=_USDC_DECIMAL)]
    currency: Literal["USDC"] = "USDC"
    chain: Literal["base"] = "base"
    max_latency_ms: Annotated[int, Field(gt=0)]
    first_call_free: bool = False
    endpoint: str
    signature: Annotated[str, Field(pattern=_HEX_BLOB)]


class _UnsignedListing(_ProtocolModel):
    """A listing as embedded inside a search result — no agent_id/signature."""

    capability: str
    price_usdc: Annotated[str, Field(pattern=_USDC_DECIMAL)]
    currency: Literal["USDC"] = "USDC"
    chain: Literal["base"] = "base"
    max_latency_ms: Annotated[int, Field(gt=0)]
    first_call_free: bool = False
    endpoint: str


# -------------------------------------------------------------------------
# Reputation
# -------------------------------------------------------------------------


class Reputation(_ProtocolModel):
    agent_id: Annotated[str, Field(pattern=_HEX_ADDRESS)]
    success_rate: float
    avg_latency_ms: float
    avg_cost_per_capability: dict[str, str] = Field(default_factory=dict)
    last_24h_volume_usdc: str = "0"
    last_30d_hire_count: int = 0
    total_ratings: int = 0
    avg_stars: float = 0.0
    claimed: bool = False


class _ReputationSummary(_ProtocolModel):
    success_rate: float = 0.0
    avg_latency_ms: float = 0.0
    last_30d_hire_count: int = 0
    avg_stars: float = 0.0
    total_ratings: int = 0
    claimed: bool = False


# -------------------------------------------------------------------------
# Search
# -------------------------------------------------------------------------


class SearchRequest(_ProtocolModel):
    capability: str
    max_price_usdc: str | None = None
    max_latency_ms: int | None = None
    min_success_rate: float | None = None
    min_avg_stars: float | None = None
    limit: int | None = None
    cursor: str | None = None


class SearchResultEntry(_ProtocolModel):
    agent_id: Annotated[str, Field(pattern=_HEX_ADDRESS)]
    listing: _UnsignedListing
    reputation: _ReputationSummary


class SearchResponse(_ProtocolModel):
    agents: list[SearchResultEntry]
    next_cursor: str | None = None
    match: Literal["exact", "prefix"] | None = None
    # On EMPTY results, the registry returns up to 20 live capability IDs so
    # a calling LLM can recover from a wrong-ID guess on the same turn.
    available_capabilities: list[str] | None = None
    total_distinct_capabilities: int | None = None


# -------------------------------------------------------------------------
# Budget token (operator-issued pre-authorization)
# -------------------------------------------------------------------------


class BudgetToken(_ProtocolModel):
    agent_id: Annotated[str, Field(pattern=_HEX_ADDRESS)]
    max_amount_usdc: Annotated[str, Field(pattern=_USDC_DECIMAL)]
    max_duration_seconds: Annotated[int, Field(gt=0)]
    issued_at: Annotated[int, Field(gt=0)]
    signature: Annotated[str, Field(pattern=_HEX_BLOB)]


# -------------------------------------------------------------------------
# Hire flow
# -------------------------------------------------------------------------


class HireRequest(_ProtocolModel):
    capability: str
    params: dict[str, Any]
    max_price_usdc: str
    agent_id: str | None = None
    endpoint: str | None = None
    max_latency_ms: int | None = None
    budget_token: BudgetToken | None = None
    callback_url: str | None = None
    nonce: str | None = None
    validate_seller: bool = True

    @field_validator("max_price_usdc")
    @classmethod
    def _check_max_price(cls, v: str) -> str:
        import re

        if not re.match(_USDC_DECIMAL, v):
            raise ValueError(f"max_price_usdc must match {_USDC_DECIMAL}, got {v!r}")
        return v


class VerificationCheck(_ProtocolModel):
    name: str
    passed: bool
    detail: str | None = None


class VerificationResult(_ProtocolModel):
    checks: list[VerificationCheck]
    all_passed: bool


class Receipt(_ProtocolModel):
    receipt_id: str
    buyer_id: str
    seller_id: str
    capability: str
    tx_hash: str
    price_paid_usdc: str
    completed_at: int  # unix seconds


class HireResponse(_ProtocolModel):
    protocol: ProtocolVersion
    receipt: Receipt
    result: dict[str, Any]
    verification: VerificationResult
    rating_token: str


class AsyncHireResponse(_ProtocolModel):
    protocol: ProtocolVersion
    job_id: str
    estimated_completion_ms: int


class _JobPending(_ProtocolModel):
    status: Literal["pending"]
    job_id: str
    estimated_completion_ms: int


class _JobComplete(_ProtocolModel):
    status: Literal["complete"]
    job_id: str
    response: HireResponse


class _JobFailed(_ProtocolModel):
    status: Literal["failed"]
    job_id: str
    error: str


JobStatus = Union[_JobPending, _JobComplete, _JobFailed]


# -------------------------------------------------------------------------
# Rating
# -------------------------------------------------------------------------

Stars = Literal[1, 2, 3, 4, 5]


class RatingRequest(_ProtocolModel):
    rating_token: str
    stars: Stars
    latency_ms: int | None = None
    comment: str | None = None


# -------------------------------------------------------------------------
# Seller-submitted receipts (Layer 3 of the 4-layer data capture)
# -------------------------------------------------------------------------


class SubmittedReceipt(_ProtocolModel):
    id: str
    protocol_version: str
    hire_id: str
    agent_id: str
    buyer: str
    capability: str
    capability_version: str | None = None
    amount_usdc_atomic: str
    network: Network
    tx_hash: str
    completed_at: str
    verification_all_passed: bool
    verification_checks: dict[str, bool] = Field(default_factory=dict)
    signature: str
    ts: int | None = None


__all__ = [
    "PROTOCOL_VERSION",
    "ProtocolVersion",
    "AgentId",
    "UsdcAmount",
    "CapabilityId",
    "Hex",
    "Network",
    "Listing",
    "Reputation",
    "SearchRequest",
    "SearchResultEntry",
    "SearchResponse",
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
]
