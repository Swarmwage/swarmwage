# Swarmwage Agent SDK (Python) — AgentClient
# Mirrors packages/sdk-ts/src/client.ts
# License: MIT

from __future__ import annotations

import os
import time
import uuid
from typing import Any

from eth_account import Account
from eth_account.signers.local import LocalAccount

from . import _payment
from ._payment import (
    SWARMWAGE_FACILITATOR_URL,
    PaidResponse,
    resolve_facilitator_url,
)
from ._signing import sign_typed_payload
from ._transport import DEFAULT_REGISTRY_URL, Transport
from .errors import (
    HireRefusedError,
    InvalidProtocolVersionError,
    VerificationFailedError,
)
from .receipts import ReceiptPayload, SubmitReceiptResult, submit_receipt
from .endpoint_verify import sign_endpoint_verify
from .telemetry import Telemetry
from .types import (
    PROTOCOL_VERSION,
    BudgetToken,
    HireRequest,
    HireResponse,
    Listing,
    Reputation,
    SearchRequest,
    SearchResponse,
    SearchResultEntry,
    SubmittedReceipt,
)
from .verification import verify

ZERO_HASH = "0x" + "0" * 64


class AgentClient:
    """Synchronous Python client for the Swarmwage protocol.

    The client owns a private key (wallet) used both as the agent identity
    and as the EIP-3009 signer for x402 settlement. Read-only methods talk
    only to the public registry; ``hire`` resolves a seller endpoint via
    search and runs an x402 paid POST against it, mirroring the TypeScript
    SDK's flow.
    """

    def __init__(
        self,
        *,
        private_key: str,
        registry_url: str = DEFAULT_REGISTRY_URL,
        network: str = "base",
        telemetry: bool | None = None,
        budget: BudgetToken | None = None,
        facilitator_url: str | None = SWARMWAGE_FACILITATOR_URL,
    ) -> None:
        self._account: LocalAccount = Account.from_key(private_key)
        self.agent_id: str = self._account.address.lower()
        self.registry_url = registry_url.rstrip("/")
        self.network = network
        # Pass the process environment so `SWARMWAGE_FACILITATOR=0` (and
        # `false|off|no`) actually opts the buyer out of the canonical
        # facilitator. Without `env=`, the helper defaulted to an empty
        # dict and silently ignored the env var.
        self.facilitator_url = resolve_facilitator_url(
            facilitator_url=facilitator_url,
            env=dict(os.environ),
        )
        self._budget = budget
        self._transport = Transport(self.registry_url)
        self._telemetry = Telemetry(agent_id=self.agent_id, enabled=telemetry)

    # ------------------------------------------------------------------
    # Resource cleanup
    # ------------------------------------------------------------------

    def close(self) -> None:
        self._transport.close()

    def __enter__(self) -> AgentClient:
        return self

    def __exit__(self, *exc_info: object) -> None:
        self.close()

    # ------------------------------------------------------------------
    # Discovery (read-only)
    # ------------------------------------------------------------------

    def search(
        self,
        *,
        capability: str,
        max_price_usdc: str | None = None,
        max_latency_ms: int | None = None,
        min_success_rate: float | None = None,
        min_avg_stars: float | None = None,
        limit: int | None = None,
        cursor: str | None = None,
    ) -> list[SearchResultEntry]:
        req = SearchRequest(
            capability=capability,
            max_price_usdc=max_price_usdc,
            max_latency_ms=max_latency_ms,
            min_success_rate=min_success_rate,
            min_avg_stars=min_avg_stars,
            limit=limit,
            cursor=cursor,
        )
        raw = self._transport.request_json(
            "POST",
            "/v1/search",
            json=req.model_dump(exclude_none=True),
        )
        resp = SearchResponse.model_validate(raw)
        self._telemetry.send(
            {
                "kind": "search",
                "capability": capability,
                "result_count": len(resp.agents),
            }
        )
        return resp.agents

    def get_reputation(self, agent_id: str) -> Reputation:
        raw = self._transport.request_json("GET", f"/v1/agents/{agent_id}/reputation")
        return Reputation.model_validate(raw)

    def get_my_listings(self) -> list[Listing]:
        raw = self._transport.request_json("GET", f"/v1/agents/{self.agent_id}/listings")
        listings = raw.get("listings", [])
        return [Listing.model_validate(item) for item in listings]

    def get_my_receipts(self, *, limit: int | None = None) -> list[SubmittedReceipt]:
        path = f"/v1/agents/{self.agent_id}/receipts"
        if limit is not None:
            path = f"{path}?limit={int(limit)}"
        raw = self._transport.request_json("GET", path)
        receipts = raw.get("receipts", [])
        return [SubmittedReceipt.model_validate(item) for item in receipts]

    # ------------------------------------------------------------------
    # Hire (sync)
    # ------------------------------------------------------------------

    def hire(
        self,
        *,
        capability: str,
        params: dict[str, Any],
        max_price_usdc: str,
        agent_id: str | None = None,
        endpoint: str | None = None,
        max_latency_ms: int | None = None,
        budget_token: BudgetToken | None = None,
        nonce: str | None = None,
        validate_seller: bool = True,
    ) -> HireResponse:
        """Run a synchronous hire against a Swarmwage seller.

        Resolves the target endpoint via :meth:`search` if not provided,
        validates the seller's x402 challenge ``payTo`` against the agent_id
        the buyer intended to hire (refuses to sign on mismatch), runs the
        x402 paid POST, recovers the settlement tx_hash from the
        ``X-PAYMENT-RESPONSE`` header (since x402-hono streams it after the
        response body), runs client-side verification, and returns a
        :class:`HireResponse`.
        """
        req = HireRequest(
            capability=capability,
            params=params,
            max_price_usdc=max_price_usdc,
            agent_id=agent_id,
            endpoint=endpoint,
            max_latency_ms=max_latency_ms,
            budget_token=budget_token,
            nonce=nonce,
            validate_seller=validate_seller,
        )

        wants_free_hire = float(req.max_price_usdc) == 0.0

        seller_id = req.agent_id
        target_endpoint = req.endpoint
        if target_endpoint is None:
            candidates = self.search(
                capability=req.capability,
                max_price_usdc=None if wants_free_hire else req.max_price_usdc,
                max_latency_ms=req.max_latency_ms,
                limit=50 if seller_id else 1,
            )
            top = None
            if seller_id is not None:
                lower = seller_id.lower()
                for c in candidates:
                    if c.agent_id.lower() == lower:
                        top = c
                        break
            elif candidates:
                top = candidates[0]
            if top is None:
                raise HireRefusedError(
                    f"Agent {seller_id} has no listing for {req.capability}"
                    if seller_id
                    else f"No agents found for capability {req.capability}"
                )
            if wants_free_hire and not top.listing.first_call_free:
                raise HireRefusedError(
                    f"No free-tier agent for {req.capability}. Cheapest live "
                    f"listing is {top.listing.price_usdc} USDC — pass "
                    f"max_price_usdc='{top.listing.price_usdc}' (or higher) "
                    "to proceed with a paid hire."
                )
            seller_id = top.agent_id
            target_endpoint = top.listing.endpoint

        if req.validate_seller and seller_id is None:
            raise HireRefusedError(
                "validate_seller=True requires either agent_id or an endpoint "
                "resolved via search (so the SDK knows whose payTo to expect)."
            )

        hire_nonce = req.nonce or str(uuid.uuid4())
        body = {
            "protocol": PROTOCOL_VERSION,
            "buyer_id": self.agent_id,
            "capability": req.capability,
            "params": req.params,
            "max_price_usdc": req.max_price_usdc,
            "max_latency_ms": req.max_latency_ms,
            "budget_token": (req.budget_token or self._budget).model_dump()
            if (req.budget_token or self._budget)
            else None,
            "callback_url": None,
            "nonce": hire_nonce,
        }

        self._telemetry.send(
            {
                "kind": "hire_attempt",
                "capability": req.capability,
                "seller_id": seller_id,
            }
        )

        url = f"{target_endpoint.rstrip('/')}/hire"
        max_atomic = _usdc_to_atomic(req.max_price_usdc)
        t0 = time.monotonic()
        try:
            paid: PaidResponse = _payment.paid_request_json(
                self._transport._client,
                self._account,
                url,
                json_body=body,
                network=self.network,
                expected_seller_id=seller_id if req.validate_seller else None,
                facilitator_url=self.facilitator_url,
                max_value_atomic=max_atomic,
            )
        except Exception as exc:
            self._telemetry.send(
                {
                    "kind": "hire_failed",
                    "capability": req.capability,
                    "reason": str(exc)[:200],
                }
            )
            raise

        body_dict = paid.body
        if body_dict.get("protocol") != PROTOCOL_VERSION:
            raise InvalidProtocolVersionError(
                str(body_dict.get("protocol")), PROTOCOL_VERSION
            )

        # x402-hono attaches X-PAYMENT-RESPONSE after the body has serialized,
        # so receipts in the JSON body carry tx_hash=0x000…000. Recover the
        # real settlement hash from the header.
        receipt = body_dict.get("receipt") or {}
        if (
            paid.settlement_tx_hash
            and (not receipt.get("tx_hash") or receipt.get("tx_hash") in {ZERO_HASH, "0x", ""})
        ):
            receipt["tx_hash"] = paid.settlement_tx_hash
            body_dict["receipt"] = receipt

        response = HireResponse.model_validate(body_dict)

        verification = verify(req.capability, req.params, response.result)
        if not verification.all_passed:
            failed = [c.model_dump() for c in verification.checks if not c.passed]
            raise VerificationFailedError(failed)

        elapsed_ms = int((time.monotonic() - t0) * 1000)
        self._telemetry.send(
            {
                "kind": "hire_complete",
                "capability": req.capability,
                "seller_id": response.receipt.seller_id,
                "price_usdc": response.receipt.price_paid_usdc,
                "latency_ms": elapsed_ms,
                "all_passed": True,
            }
        )

        return response

    # ------------------------------------------------------------------
    # Hire (async) — not yet supported in 0.2 alpha
    # ------------------------------------------------------------------

    def hire_async(self, **_kwargs: Any) -> None:
        raise NotImplementedError(
            "hire_async() ships in a later alpha — use hire() for synchronous "
            "x402 settlement against capabilities that return inline results."
        )

    # ------------------------------------------------------------------
    # Rating
    # ------------------------------------------------------------------

    def rate(
        self,
        rating_token: str,
        *,
        stars: int,
        latency_ms: int | None = None,
        comment: str | None = None,
    ) -> None:
        body: dict[str, Any] = {"rating_token": rating_token, "stars": stars}
        if latency_ms is not None:
            body["latency_ms"] = latency_ms
        if comment is not None:
            body["comment"] = comment
        self._transport.request_json("POST", "/v1/rate", json=body)
        self._telemetry.send({"kind": "rate", "stars": stars})

    # ------------------------------------------------------------------
    # Listings (sellers)
    # ------------------------------------------------------------------

    def publish_listing(
        self,
        *,
        capability: str,
        price_usdc: str,
        endpoint: str,
        max_latency_ms: int,
        first_call_free: bool = False,
        currency: str = "USDC",
        chain: str = "base",
    ) -> Listing:
        """Sign and POST a listing to the canonical registry.

        Fills in `agent_id` from this client's wallet, signs the
        canonical payload, and submits to `POST /v1/listings`. Returns
        the signed listing (including the `signature` field) on success.
        """
        partial: dict[str, Any] = {
            "agent_id": self.agent_id,
            "capability": capability,
            "price_usdc": price_usdc,
            "currency": currency,
            "chain": chain,
            "max_latency_ms": max_latency_ms,
            "first_call_free": first_call_free,
            "endpoint": endpoint,
        }
        signature = sign_typed_payload(self._account, partial)
        signed_body = {**partial, "signature": signature}
        self._transport.request_json("POST", "/v1/listings", json=signed_body)
        self._telemetry.send(
            {
                "kind": "publish_listing",
                "capability": capability,
                "price_usdc": price_usdc,
            }
        )
        return Listing.model_validate(signed_body)

    # ------------------------------------------------------------------
    # Receipts (sellers) — Layer 3 of the 4-layer data capture
    # ------------------------------------------------------------------

    def submit_receipt(
        self,
        *,
        hire_id: str,
        buyer: str,
        capability: str,
        amount_usdc_atomic: str,
        network: str,
        tx_hash: str,
        completed_at: str,
        verification: dict[str, Any],
        capability_version: str | None = None,
        enabled: bool | None = None,
    ) -> SubmitReceiptResult:
        """Sign and submit a receipt for a fulfilled hire (seller-side).

        Fire-and-forget: never raises. Errors come back inside the
        :class:`SubmitReceiptResult`. Defaults to ON; respects the
        ``SWARMWAGE_RECEIPTS=0`` opt-out env var.
        """
        payload = ReceiptPayload(
            protocol_version=PROTOCOL_VERSION,
            hire_id=hire_id,
            agent_id=self.agent_id,
            buyer=buyer,
            capability=capability,
            capability_version=capability_version,
            amount_usdc_atomic=amount_usdc_atomic,
            network=network,
            tx_hash=tx_hash,
            completed_at=completed_at,
            verification=verification,
        )
        # Sign with the LocalAccount; submit_receipt accepts a string key
        # so we extract a 0x-prefixed hex for it (handles HexBytes shape).
        key_bytes = self._account.key
        key_hex = key_bytes.hex() if hasattr(key_bytes, "hex") else str(key_bytes)
        if not key_hex.startswith("0x"):
            key_hex = "0x" + key_hex
        result = submit_receipt(
            seller_private_key=key_hex,
            payload=payload,
            registry_url=self.registry_url,
            enabled=enabled,
            http_client=self._transport._client,
        )
        self._telemetry.send(
            {
                "kind": "submit_receipt",
                "capability": capability,
                "submitted": result.submitted,
                "status": result.status,
                "ok": result.error is None,
            }
        )
        return result

    # ------------------------------------------------------------------
    # Endpoint ownership proof (sellers) — Wave-2a anti-squat
    # ------------------------------------------------------------------

    def sign_endpoint_verify(self, *, nonce: str) -> dict[str, Any]:
        """Build the well-known endpoint-verify response body.

        Use from your seller HTTP handler:

            @app.get(ENDPOINT_VERIFY_PATH)
            def verify(nonce: str = ...):
                return client.sign_endpoint_verify(nonce=nonce)

        The registry challenges sellers at this path before believing
        their listing's `endpoint` URL is one they own.
        """
        key_bytes = self._account.key
        key_hex = key_bytes.hex() if hasattr(key_bytes, "hex") else str(key_bytes)
        if not key_hex.startswith("0x"):
            key_hex = "0x" + key_hex
        return sign_endpoint_verify(
            agent_id=self.agent_id,
            nonce=nonce,
            seller_private_key=key_hex,
        )


def _usdc_to_atomic(price_usdc: str) -> int:
    """Convert a human-readable USDC decimal string to 6-decimal atomic units."""
    if "." in price_usdc:
        int_part, frac_part = price_usdc.split(".", 1)
    else:
        int_part, frac_part = price_usdc, ""
    frac_part = (frac_part + "000000")[:6]
    return int((int_part or "0") + frac_part)


__all__ = ["AgentClient"]
