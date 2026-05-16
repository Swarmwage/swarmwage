# License: MIT
# Tests for AgentClient.publish_listing — seller-side.
from __future__ import annotations

import json

import httpx
from eth_account import Account

from swarmwage import AgentClient, Listing
from swarmwage._signing import sign_typed_payload

SELLER_KEY = "0x" + "33" * 32
SELLER_ID = Account.from_key(SELLER_KEY).address.lower()


def test_publish_listing_signs_and_posts() -> None:
    captured: dict = {}

    def handler(req: httpx.Request) -> httpx.Response:
        captured["url"] = str(req.url)
        captured["method"] = req.method
        captured["body"] = json.loads(req.content)
        return httpx.Response(200, json={"ok": True})

    client = AgentClient(private_key=SELLER_KEY, telemetry=False)
    client._transport._client.close()
    client._transport._client = httpx.Client(transport=httpx.MockTransport(handler))
    try:
        listing = client.publish_listing(
            capability="image.generate.photorealistic.png",
            price_usdc="0.05",
            endpoint="https://example.com/hire",
            max_latency_ms=30_000,
            first_call_free=False,
        )
    finally:
        client.close()

    assert isinstance(listing, Listing)
    assert listing.agent_id == SELLER_ID
    assert captured["method"] == "POST"
    assert captured["url"].endswith("/v1/listings")

    posted = captured["body"]
    # Defaults filled in
    assert posted["agent_id"] == SELLER_ID
    assert posted["currency"] == "USDC"
    assert posted["chain"] == "base"
    assert posted["first_call_free"] is False
    # Signature is over the partial (everything except signature itself)
    partial = {k: v for k, v in posted.items() if k != "signature"}
    expected_sig = sign_typed_payload(SELLER_KEY, partial)
    assert posted["signature"] == expected_sig


def test_publish_listing_first_call_free_flag_propagates() -> None:
    captured: dict = {}

    def handler(req: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(req.content)
        return httpx.Response(200, json={"ok": True})

    client = AgentClient(private_key=SELLER_KEY, telemetry=False)
    client._transport._client.close()
    client._transport._client = httpx.Client(transport=httpx.MockTransport(handler))
    try:
        client.publish_listing(
            capability="audio.transcribe.json-with-timestamps",
            price_usdc="0.10",
            endpoint="https://example.com/hire",
            max_latency_ms=5_000,
            first_call_free=True,
        )
    finally:
        client.close()

    assert captured["body"]["first_call_free"] is True
