# Swarmwage Agent SDK (Python) — seller-side receipt submission
# Mirrors packages/sdk-ts/src/receipts.ts
# License: MIT
#
# Layer 3 of the 4-layer data-capture model: sellers sign and submit
# receipts after each fulfilled hire so their public reputation
# reflects on-protocol activity. Default ON; opt out via env var
# `SWARMWAGE_RECEIPTS=0`.

from __future__ import annotations

import os
import sys
from dataclasses import dataclass, field
from typing import Any, Callable

import httpx
from eth_account import Account
from eth_keys.exceptions import ValidationError as _KeysValidationError

from ._signing import sign_typed_payload

DEFAULT_REGISTRY_URL = "https://api.swarmwage.com"

# Fields a ReceiptPayload (or equivalent dict) must contain before we'll
# sign it. Missing fields would silently produce a signature over an
# incomplete body that the registry will 4xx — turning a programming bug
# into a confusing fire-and-forget failure. Validate up front instead.
_REQUIRED_RECEIPT_FIELDS = frozenset(
    {
        "protocol_version",
        "hire_id",
        "agent_id",
        "buyer",
        "capability",
        "amount_usdc_atomic",
        "network",
        "tx_hash",
        "completed_at",
        "verification",
    }
)


@dataclass
class ReceiptPayload:
    """The fields the seller signs.

    Sent verbatim to the registry. The signature is computed over the
    canonical-JSON serialization of this dict (see `_signing`).
    """

    protocol_version: str
    hire_id: str
    agent_id: str
    buyer: str
    capability: str
    amount_usdc_atomic: str
    network: str  # "base" | "base-sepolia"
    tx_hash: str
    completed_at: str  # ISO 8601
    verification: dict[str, Any]
    capability_version: str | None = None

    def to_dict(self) -> dict[str, Any]:
        d: dict[str, Any] = {
            "protocol_version": self.protocol_version,
            "hire_id": self.hire_id,
            "agent_id": self.agent_id,
            "buyer": self.buyer,
            "capability": self.capability,
            "amount_usdc_atomic": self.amount_usdc_atomic,
            "network": self.network,
            "tx_hash": self.tx_hash,
            "completed_at": self.completed_at,
            "verification": self.verification,
        }
        if self.capability_version is not None:
            d["capability_version"] = self.capability_version
        return d


@dataclass
class SubmitReceiptResult:
    submitted: bool
    status: int | None = None
    receipt_id: str | None = None
    error: str | None = None


def is_receipts_enabled(
    enabled: bool | None = None,
    env: dict[str, str] | None = None,
) -> bool:
    """Decide whether receipt submission is enabled.

    Mirrors `AGENT_TELEMETRY` opt-out semantics: env var precedence
    after an explicit `enabled=` flag.
    """
    if enabled is not None:
        return enabled
    env_map = env if env is not None else dict(os.environ)
    raw = env_map.get("SWARMWAGE_RECEIPTS")
    if raw is None:
        return True
    v = raw.strip().lower()
    if v in ("0", "false", "off", "no"):
        return False
    return True


def sign_receipt(
    seller_private_key: str,
    payload: ReceiptPayload | dict[str, Any],
) -> dict[str, Any]:
    """Sign a receipt payload and return the body the registry expects."""
    body = payload.to_dict() if isinstance(payload, ReceiptPayload) else dict(payload)
    signature = sign_typed_payload(seller_private_key, body)
    return {**body, "signature": signature}


def _default_logger(msg: str) -> None:
    try:
        sys.stderr.write(f"swarmwage-receipts: {msg}\n")
    except Exception:
        # logging is best-effort
        pass


def submit_receipt(
    *,
    seller_private_key: str,
    payload: ReceiptPayload | dict[str, Any],
    registry_url: str = DEFAULT_REGISTRY_URL,
    enabled: bool | None = None,
    logger: Callable[[str], None] | None = None,
    http_client: httpx.Client | None = None,
    timeout: float = 10.0,
) -> SubmitReceiptResult:
    """Submit a signed receipt to the registry.

    Fire-and-forget semantics: never raises. Errors are returned in the
    result and logged via `logger`. Safe to call from a seller's `/hire`
    handler without blocking the buyer response.

    Default ON; set env `SWARMWAGE_RECEIPTS=0` to disable.
    """
    log = logger or _default_logger

    if not is_receipts_enabled(enabled):
        return SubmitReceiptResult(submitted=False)

    body_dict = (
        payload.to_dict() if isinstance(payload, ReceiptPayload) else dict(payload)
    )

    # Validate up front so a missing required field surfaces as a clear
    # caller error rather than a "submitted=True, error='sign failed: ...'"
    # ambiguity that masks the bug.
    missing = sorted(_REQUIRED_RECEIPT_FIELDS - set(body_dict.keys()))
    if missing:
        msg = (
            f"receipt payload missing required field(s): {missing}. "
            "Pass a `ReceiptPayload` (dataclass) or a dict with all of: "
            f"{sorted(_REQUIRED_RECEIPT_FIELDS)}."
        )
        log(msg)
        return SubmitReceiptResult(submitted=True, error=msg)

    # Sanity: the payload must declare itself as the wallet we're signing with.
    try:
        wallet_address = Account.from_key(seller_private_key).address.lower()
    except (_KeysValidationError, ValueError, TypeError) as exc:
        # Narrow exception classes so a typo in the key surfaces clearly
        # while real programming errors (AttributeError on a wrong object
        # shape, etc.) bubble up to the caller instead of being swallowed
        # under a generic "sign failed".
        msg = f"sign failed: bad private key ({type(exc).__name__}: {exc})"
        log(msg)
        return SubmitReceiptResult(submitted=True, error=msg)

    payload_agent = str(body_dict.get("agent_id", "")).lower()
    if payload_agent != wallet_address:
        msg = (
            f"payload.agent_id {payload_agent!r} does not match seller wallet "
            f"{wallet_address!r}"
        )
        log(msg)
        return SubmitReceiptResult(submitted=True, error=msg)

    try:
        signed_body = sign_receipt(seller_private_key, body_dict)
    except (_KeysValidationError, ValueError, TypeError) as exc:
        msg = f"sign failed: {type(exc).__name__}: {exc}"
        log(msg)
        return SubmitReceiptResult(submitted=True, error=msg)

    url = f"{registry_url.rstrip('/')}/v1/receipts"
    owns_client = http_client is None
    client = http_client or httpx.Client(timeout=timeout)
    try:
        resp = client.post(url, json=signed_body)
        if resp.status_code >= 400:
            try:
                txt = resp.text
            except Exception:
                txt = ""
            log(f"registry rejected receipt ({resp.status_code}): {txt}")
            return SubmitReceiptResult(
                submitted=True, status=resp.status_code, error=txt or resp.reason_phrase
            )
        try:
            payload_json = resp.json()
        except Exception:
            payload_json = {}
        return SubmitReceiptResult(
            submitted=True,
            status=resp.status_code,
            receipt_id=payload_json.get("receipt_id") if isinstance(payload_json, dict) else None,
        )
    except httpx.HTTPError as exc:
        msg = f"network error: {exc}"
        log(msg)
        return SubmitReceiptResult(submitted=True, error=msg)
    finally:
        if owns_client:
            client.close()


__all__ = [
    "DEFAULT_REGISTRY_URL",
    "ReceiptPayload",
    "SubmitReceiptResult",
    "is_receipts_enabled",
    "sign_receipt",
    "submit_receipt",
]
