# License: MIT
# Tests for seller-side endpoint-ownership proof signing.
from __future__ import annotations

from eth_account import Account

from swarmwage import (
    AgentClient,
    ENDPOINT_VERIFY_PATH,
    sign_endpoint_verify,
)
from swarmwage._signing import sign_typed_payload

SELLER_KEY = "0x" + "33" * 32
SELLER_ID = Account.from_key(SELLER_KEY).address.lower()


def test_well_known_path_is_stable() -> None:
    """The registry hardcodes this path — never change it without
    cross-bumping the SDK + registry together."""
    assert ENDPOINT_VERIFY_PATH == "/.well-known/swarmwage-verify"


def test_sign_endpoint_verify_returns_expected_shape() -> None:
    response = sign_endpoint_verify(
        agent_id=SELLER_ID,
        nonce="opaque-nonce-12345678",
        seller_private_key=SELLER_KEY,
    )
    assert response["agent_id"] == SELLER_ID
    assert response["nonce"] == "opaque-nonce-12345678"
    assert response["signature"].startswith("0x")
    assert len(response["signature"]) == 132

    # Signature must match the canonical signing over {agent_id, nonce}.
    expected = sign_typed_payload(
        SELLER_KEY,
        {"agent_id": SELLER_ID, "nonce": "opaque-nonce-12345678"},
    )
    assert response["signature"] == expected


def test_agent_client_sign_endpoint_verify_uses_own_wallet() -> None:
    client = AgentClient(private_key=SELLER_KEY, telemetry=False)
    try:
        response = client.sign_endpoint_verify(nonce="opaque-nonce-12345678")
    finally:
        client.close()

    assert response["agent_id"] == SELLER_ID
    expected = sign_typed_payload(
        SELLER_KEY,
        {"agent_id": SELLER_ID, "nonce": "opaque-nonce-12345678"},
    )
    assert response["signature"] == expected
