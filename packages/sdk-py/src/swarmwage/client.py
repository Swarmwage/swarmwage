# Swarmwage Agent SDK (Python) — AgentClient
# Mirrors packages/sdk-ts/src/client.ts
# License: MIT

from __future__ import annotations

import time
import uuid
from typing import Any

from eth_account import Account
from eth_account.signers.local import LocalAccount

from . import _payment, _x402
from ._payment import (
    SWARMWAGE_FACILITATOR_URL,
    PaidResponse,
    resolve_facilitator_url,
)
from ._transport import DEFAULT_REGISTRY_URL, Transport
from .errors import (
    HireRefusedError,
    InvalidProtocolVersionError,
    VerificationFailedError,
)
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
        self.facilitator_url = resolve_facilitator_url(facilitator_url=facilitator_url)
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
    # Listings (sellers) — publish requires off-chain EIP-712 listing
    # signature, deferred until a later alpha.
    # ------------------------------------------------------------------

    def publish_listing(self, _listing: Any) -> None:
        raise NotImplementedError(
            "publish_listing() requires EIP-712 listing signature scaffolding "
            "and ships in a later alpha. The TS SDK is the seller-side path "
            "today."
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
