# Swarmwage Agent SDK (Python) — x402 paid-request orchestrator
# License: MIT
#
# One function: ``paid_request_json`` runs the full x402 handshake against a
# seller endpoint. The 402 dance is delegated to :mod:`swarmwage._x402` for
# wire-level operations; everything in this file is HTTP + retry logic +
# anti-hijack validation.

from __future__ import annotations

from typing import Any

import httpx
from eth_account.signers.local import LocalAccount

from . import _x402
from .errors import (
    InsufficientFundsError,
    PaymentFailedError,
    SellerMismatchError,
    TransportError,
)
from .types import PROTOCOL_VERSION

SWARMWAGE_FACILITATOR_URL = "https://facilitator.swarmwage.com"
SWARMWAGE_FACILITATOR_HEADER = "X-Swarmwage-Facilitator"


def resolve_facilitator_url(
    *,
    facilitator_url: str | None = None,
    env: dict[str, str | None] | None = None,
) -> str | None:
    """Mirror of TS ``resolveFacilitatorUrl``: ``None`` (omitted) → default;
    explicit empty/``"off"``/etc. env → ``None`` (opt-out); string → verbatim.
    """
    env = env or {}
    raw = env.get("SWARMWAGE_FACILITATOR")
    if raw is not None and raw.strip().lower() in {"0", "false", "off", "no"}:
        return None
    if facilitator_url is None:
        return SWARMWAGE_FACILITATOR_URL
    if facilitator_url == "":  # treat explicit empty as opt-in default
        return SWARMWAGE_FACILITATOR_URL
    return facilitator_url


class PaidResponse:
    """A successful settlement response: parsed body + decoded
    ``X-PAYMENT-RESPONSE`` metadata (when present).
    """

    __slots__ = ("body", "settlement_tx_hash", "settlement_network", "payer")

    def __init__(
        self,
        body: dict[str, Any],
        settlement_tx_hash: str | None,
        settlement_network: str | None,
        payer: str | None,
    ) -> None:
        self.body = body
        self.settlement_tx_hash = settlement_tx_hash
        self.settlement_network = settlement_network
        self.payer = payer


def paid_request_json(
    client: httpx.Client,
    account: LocalAccount,
    url: str,
    *,
    json_body: dict[str, Any],
    network: str,
    expected_seller_id: str | None = None,
    facilitator_url: str | None = SWARMWAGE_FACILITATOR_URL,
    max_value_atomic: int | None = None,
    extra_headers: dict[str, str] | None = None,
) -> PaidResponse:
    """Run a single x402 paid request cycle.

    1. POST ``json_body`` without ``X-PAYMENT``. If the seller answers 200 we
       short-circuit (free-tier hire / first_call_free / non-paid endpoint).
    2. On 402, parse the seller's ``accepts`` array, select the requirement
       matching our ``network``, optionally validate ``payTo`` against
       ``expected_seller_id``, then sign an EIP-3009 authorization with
       ``account``'s key.
    3. Retry the POST once with ``X-PAYMENT`` set. A second 402 means
       settlement failed (insufficient funds, expired auth, etc.) — surface
       as :class:`InsufficientFundsError`.

    The buyer's preferred facilitator is advertised on every request via
    ``X-Swarmwage-Facilitator``; sellers that don't recognize the header fall
    back to their own facilitator (no impact on settlement correctness).
    """
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "X-Swarmwage-Protocol": PROTOCOL_VERSION,
        "Access-Control-Expose-Headers": "X-PAYMENT-RESPONSE",
    }
    if facilitator_url:
        headers[SWARMWAGE_FACILITATOR_HEADER] = facilitator_url
    if extra_headers:
        headers.update(extra_headers)

    try:
        first = client.post(url, json=json_body, headers=headers)
    except httpx.HTTPError as exc:
        raise TransportError(f"POST {url} failed: {exc}", cause=exc) from exc

    # Free-tier or first_call_free path — no payment ever required.
    if first.status_code == 200:
        return _decode_paid_response(first)

    if first.status_code != 402:
        raise TransportError(
            f"POST {url} returned {first.status_code}: {first.text[:200]}",
            status=first.status_code,
        )

    try:
        challenge = first.json()
    except ValueError as exc:
        raise PaymentFailedError(
            f"402 challenge from {url} was not JSON ({len(first.text)} bytes)",
            cause=exc,
        ) from exc

    accepts = challenge.get("accepts")
    if not isinstance(accepts, list) or not accepts:
        raise PaymentFailedError(
            f"402 challenge from {url} missing 'accepts' array"
        )

    x402_version = int(challenge.get("x402Version", _x402.X402_VERSION))

    try:
        requirement = _x402.select_payment_requirements(accepts, network=network)
    except ValueError as exc:
        raise PaymentFailedError(str(exc), cause=exc) from exc

    if expected_seller_id is not None:
        actual_pay_to = (requirement.get("payTo") or "").lower()
        expected = expected_seller_id.lower()
        if actual_pay_to != expected:
            raise SellerMismatchError(expected, actual_pay_to or "(missing)")

    value_atomic = int(requirement.get("maxAmountRequired", 0))
    if max_value_atomic is not None and value_atomic > max_value_atomic:
        raise PaymentFailedError(
            f"Seller demands {value_atomic} atomic units but client cap is "
            f"{max_value_atomic}. Refusing to sign."
        )

    header_value, _ = _x402.create_payment_header(
        account,
        requirement,
        x402_version=x402_version,
    )

    paid_headers = {**headers, "X-PAYMENT": header_value}
    try:
        second = client.post(url, json=json_body, headers=paid_headers)
    except httpx.HTTPError as exc:
        raise TransportError(f"POST {url} (paid retry) failed: {exc}", cause=exc) from exc

    if second.status_code == 402:
        # Settlement failed downstream — almost always insufficient funds on
        # the buyer wallet. Match the TS SDK so the calling agent / MCP
        # wrapper can guide the user to fund their wallet rather than fall
        # back to a competing service.
        raise InsufficientFundsError(
            account.address.lower(),
            _atomic_to_usdc_str(value_atomic),
            network,
            expected_seller_id,
        )
    if second.status_code != 200:
        raise TransportError(
            f"POST {url} (paid retry) returned {second.status_code}: {second.text[:200]}",
            status=second.status_code,
        )

    return _decode_paid_response(second)


def _decode_paid_response(resp: httpx.Response) -> PaidResponse:
    try:
        body = resp.json()
    except ValueError as exc:
        raise TransportError(
            f"Seller returned non-JSON 200 body ({len(resp.text)} bytes)",
            status=resp.status_code,
            cause=exc,
        ) from exc
    settlement = _x402.decode_x_payment_response(resp.headers.get("X-PAYMENT-RESPONSE"))
    if settlement:
        return PaidResponse(
            body=body,
            settlement_tx_hash=settlement.get("transaction") or settlement.get("txHash"),
            settlement_network=settlement.get("network"),
            payer=settlement.get("payer"),
        )
    return PaidResponse(body=body, settlement_tx_hash=None, settlement_network=None, payer=None)


def _atomic_to_usdc_str(value: int) -> str:
    if value <= 0:
        return "0.00"
    cents = divmod(value, 1_000_000)
    return f"{cents[0]}.{cents[1]:06d}"


__all__ = [
    "SWARMWAGE_FACILITATOR_URL",
    "SWARMWAGE_FACILITATOR_HEADER",
    "PaidResponse",
    "paid_request_json",
    "resolve_facilitator_url",
]
