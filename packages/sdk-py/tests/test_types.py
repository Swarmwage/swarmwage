# License: MIT
from __future__ import annotations

import pytest
from pydantic import ValidationError

from swarmwage import (
    HireRequest,
    Listing,
    SearchRequest,
    SearchResponse,
    SearchResultEntry,
)


def test_listing_round_trip() -> None:
    fixture = {
        "agent_id": "0x" + "ab" * 20,
        "capability": "image.generate.photorealistic.png",
        "price_usdc": "0.05",
        "currency": "USDC",
        "chain": "base",
        "max_latency_ms": 5000,
        "first_call_free": True,
        "endpoint": "https://chart-gen.swarmwage.com",
        "signature": "0xdeadbeef",
    }
    listing = Listing.model_validate(fixture)
    assert listing.agent_id == fixture["agent_id"]
    assert listing.first_call_free is True
    # dump back and verify field shape
    dumped = listing.model_dump()
    assert dumped["price_usdc"] == "0.05"
    assert dumped["chain"] == "base"


def test_listing_rejects_bad_address() -> None:
    with pytest.raises(ValidationError):
        Listing.model_validate(
            {
                "agent_id": "not-an-address",
                "capability": "x",
                "price_usdc": "0.01",
                "max_latency_ms": 1000,
                "endpoint": "https://example.com",
                "signature": "0xab",
            }
        )


def test_search_request_omits_none_on_dump() -> None:
    req = SearchRequest(capability="image.generate")
    assert req.model_dump(exclude_none=True) == {"capability": "image.generate"}


def test_search_response_empty_with_recovery_hint() -> None:
    raw = {
        "agents": [],
        "next_cursor": None,
        "available_capabilities": ["image.generate.png", "audio.transcribe"],
        "total_distinct_capabilities": 42,
    }
    parsed = SearchResponse.model_validate(raw)
    assert parsed.agents == []
    assert parsed.available_capabilities == [
        "image.generate.png",
        "audio.transcribe",
    ]
    assert parsed.total_distinct_capabilities == 42


def test_search_result_entry_with_unsigned_inner_listing() -> None:
    raw = {
        "agent_id": "0x" + "cd" * 20,
        "listing": {
            "capability": "audio.transcribe",
            "price_usdc": "0.02",
            "max_latency_ms": 3000,
            "endpoint": "https://transcribe.swarmwage.com",
        },
        "reputation": {
            "success_rate": 0.98,
            "avg_latency_ms": 1200,
            "last_30d_hire_count": 47,
            "avg_stars": 4.6,
            "total_ratings": 30,
            "claimed": True,
        },
    }
    entry = SearchResultEntry.model_validate(raw)
    assert entry.listing.first_call_free is False
    assert entry.reputation.success_rate == pytest.approx(0.98)


def test_hire_request_rejects_bad_max_price() -> None:
    with pytest.raises(ValidationError):
        HireRequest(
            capability="image.generate",
            params={},
            max_price_usdc="five cents",
        )
