# Swarmwage Agent SDK (Python) — AgentClient
# Mirrors packages/sdk-ts/src/client.ts (read-only methods only in 0.1.x)
# License: MIT

from __future__ import annotations

from typing import Any

from eth_account import Account
from eth_account.signers.local import LocalAccount

from ._transport import DEFAULT_REGISTRY_URL, Transport
from .errors import HireRefusedError
from .telemetry import Telemetry
from .types import (
    Listing,
    Reputation,
    SearchRequest,
    SearchResponse,
    SearchResultEntry,
    SubmittedReceipt,
)


class AgentClient:
    """Synchronous Python client for the Swarmwage protocol.

    0.1.x ships read-only methods (search, get_reputation, get_my_listings,
    get_my_receipts) that talk to the public registry. Paid methods
    (``hire``, ``hire_async``, ``rate``, ``publish_listing``) raise
    :class:`NotImplementedError` until x402 + EIP-3009 integration lands in
    0.2.
    """

    def __init__(
        self,
        *,
        private_key: str,
        registry_url: str = DEFAULT_REGISTRY_URL,
        network: str = "base",
        telemetry: bool | None = None,
    ) -> None:
        self._account: LocalAccount = Account.from_key(private_key)
        self.agent_id: str = self._account.address.lower()
        self.registry_url = registry_url.rstrip("/")
        self.network = network
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
    # Discovery (read-only — implemented)
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
        if not resp.agents and resp.available_capabilities is not None:
            # Surface the registry's recovery hint into the exception path
            # callers may want — but for search() itself we just return [].
            pass
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
    # Paid operations (NOT YET IMPLEMENTED in 0.1.x)
    # ------------------------------------------------------------------

    def hire(self, **_kwargs: Any) -> None:
        raise NotImplementedError(
            "hire() requires x402 + EIP-3009 settlement, which is scheduled for "
            "swarmwage 0.2. For end-to-end hires today, use the TypeScript SDK "
            "(@swarmwage/agent-sdk) or the MCP server (npx @swarmwage/mcp)."
        )

    def hire_async(self, **_kwargs: Any) -> None:
        raise NotImplementedError("hire_async() lands in swarmwage 0.2 alongside hire().")

    def rate(self, **_kwargs: Any) -> None:
        raise NotImplementedError(
            "rate() requires a valid rating_token from a completed hire — "
            "implemented in swarmwage 0.2 alongside hire()."
        )

    def publish_listing(self, _listing: Any) -> None:
        raise NotImplementedError(
            "publish_listing() requires EIP-712 listing signature, which lands "
            "in swarmwage 0.2."
        )

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    def _refuse(self, reason: str) -> None:
        """Internal helper used by the hire path once implemented."""
        raise HireRefusedError(reason)


__all__ = ["AgentClient"]
