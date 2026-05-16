# License: MIT
# Integration test for the x402 paid-request orchestrator using httpx.MockTransport.
# Covers: 402 challenge handshake, payTo anti-hijack rejection, second-402 →
# InsufficientFundsError, free-tier short-circuit.
from __future__ import annotations

import base64
import json
from typing import Any

import httpx
import pytest
from eth_account import Account
from eth_account.messages import encode_typed_data

from swarmwage import _x402
from swarmwage._payment import paid_request_json
from swarmwage.errors import (
    InsufficientFundsError,
    PaymentFailedError,
    SellerMismatchError,
)

TEST_KEY = "0x" + "11" * 32
SELLER = "0xfC6f3465EF7324756135bF6Ace932D1d36748609"


def _build_challenge(network: str = "base", value: str = "50000") -> dict[str, Any]:
    return {
        "x402Version": 1,
        "error": "X-PAYMENT header is required",
        "accepts": [
            {
                "scheme": "exact",
                "network": network,
                "maxAmountRequired": value,
                "resource": "https://seller.example/hire",
                "description": "test",
                "mimeType": "application/json",
                "payTo": SELLER,
                "maxTimeoutSeconds": 60,
                "asset": _x402.USDC_ASSET_BY_CHAIN_ID[8453]
                if network == "base"
                else _x402.USDC_ASSET_BY_CHAIN_ID[84532],
                "extra": {"name": "USD Coin", "version": "2"},
            }
        ],
    }


def _settlement_header(tx_hash: str, network: str = "base") -> str:
    payload = {
        "success": True,
        "transaction": tx_hash,
        "network": network,
        "payer": Account.from_key(TEST_KEY).address,
    }
    return base64.b64encode(json.dumps(payload).encode("utf-8")).decode("ascii")


def _verify_signature(payment_dict: dict[str, Any]) -> str:
    """Reproduce the seller-side recovery step. Returns the recovered signer."""
    auth = payment_dict["payload"]["authorization"]
    typed = {
        "types": _x402.AUTHORIZATION_TYPES,
        "domain": {
            "name": "USD Coin",
            "version": "2",
            "chainId": _x402.network_to_chain_id(payment_dict["network"]),
            "verifyingContract": _x402.usdc_address_for(payment_dict["network"]),
        },
        "primaryType": "TransferWithAuthorization",
        "message": {
            "from": auth["from"],
            "to": auth["to"],
            "value": int(auth["value"]),
            "validAfter": int(auth["validAfter"]),
            "validBefore": int(auth["validBefore"]),
            "nonce": auth["nonce"],
        },
    }
    msg = encode_typed_data(full_message=typed)
    return Account.recover_message(msg, signature=payment_dict["payload"]["signature"])


def test_paid_request_handshake_success() -> None:
    """A standard 402 → signed retry → 200 + settlement header round trip."""
    captured: dict[str, Any] = {}
    expected_tx = "0x" + "ab" * 32

    def handler(req: httpx.Request) -> httpx.Response:
        if "X-PAYMENT" not in req.headers:
            return httpx.Response(402, json=_build_challenge())
        # Decode the X-PAYMENT header, validate the buyer signed correctly.
        decoded = json.loads(base64.b64decode(req.headers["X-PAYMENT"]).decode("utf-8"))
        captured["payment"] = decoded
        captured["facilitator_hint"] = req.headers.get("X-Swarmwage-Facilitator")
        recovered = _verify_signature(decoded)
        assert recovered.lower() == Account.from_key(TEST_KEY).address.lower()
        return httpx.Response(
            200,
            json={"protocol": "swarmwage/v0.1", "ok": True},
            headers={"X-PAYMENT-RESPONSE": _settlement_header(expected_tx)},
        )

    transport = httpx.MockTransport(handler)
    with httpx.Client(transport=transport) as client:
        result = paid_request_json(
            client,
            Account.from_key(TEST_KEY),
            "https://seller.example/hire",
            allow_internal_endpoint=True,
            json_body={"protocol": "swarmwage/v0.1"},
            network="base",
            expected_seller_id=SELLER,
            facilitator_url="https://facilitator.swarmwage.com",
        )

    assert result.body == {"protocol": "swarmwage/v0.1", "ok": True}
    assert result.settlement_tx_hash == expected_tx
    assert result.settlement_network == "base"
    assert captured["payment"]["payload"]["authorization"]["to"] == SELLER
    assert captured["facilitator_hint"] == "https://facilitator.swarmwage.com"


def test_paid_request_rejects_seller_mismatch() -> None:
    """If the seller's challenge requests payment to a different address than
    the agent_id we wanted to hire, refuse to sign — even if we hold funds.
    """
    challenge = _build_challenge()
    challenge["accepts"][0]["payTo"] = "0x000000000000000000000000000000000000dEaD"

    def handler(req: httpx.Request) -> httpx.Response:
        return httpx.Response(402, json=challenge)

    transport = httpx.MockTransport(handler)
    with httpx.Client(transport=transport) as client:
        with pytest.raises(SellerMismatchError) as exc_info:
            paid_request_json(
                client,
                Account.from_key(TEST_KEY),
                "https://seller.example/hire",
                allow_internal_endpoint=True,
                json_body={"protocol": "swarmwage/v0.1"},
                network="base",
                expected_seller_id=SELLER,
            )

    assert exc_info.value.expected == SELLER.lower()
    assert exc_info.value.actual.lower().startswith("0x000")


def test_paid_request_surfaces_insufficient_funds() -> None:
    """Two consecutive 402s → InsufficientFundsError (after the signed retry,
    the seller's facilitator rejected settlement)."""

    def handler(_req: httpx.Request) -> httpx.Response:
        return httpx.Response(402, json=_build_challenge(value="999999999"))

    transport = httpx.MockTransport(handler)
    with httpx.Client(transport=transport) as client:
        with pytest.raises(InsufficientFundsError):
            paid_request_json(
                client,
                Account.from_key(TEST_KEY),
                "https://seller.example/hire",
                allow_internal_endpoint=True,
                json_body={"protocol": "swarmwage/v0.1"},
                network="base",
                expected_seller_id=SELLER,
            )


def test_paid_request_rejects_over_cap_value() -> None:
    """If the seller asks for more than the buyer's max_value_atomic cap,
    refuse to sign and surface PaymentFailedError."""

    def handler(_req: httpx.Request) -> httpx.Response:
        return httpx.Response(402, json=_build_challenge(value="2000000"))  # 2 USDC

    transport = httpx.MockTransport(handler)
    with httpx.Client(transport=transport) as client:
        with pytest.raises(PaymentFailedError) as exc_info:
            paid_request_json(
                client,
                Account.from_key(TEST_KEY),
                "https://seller.example/hire",
                allow_internal_endpoint=True,
                json_body={"protocol": "swarmwage/v0.1"},
                network="base",
                expected_seller_id=SELLER,
                max_value_atomic=1_000_000,  # cap at 1 USDC
            )
    assert "2000000" in str(exc_info.value) or "cap" in str(exc_info.value)


def test_paid_request_short_circuits_on_200() -> None:
    """Free-tier (first_call_free) sellers may answer 200 directly without
    issuing an x402 challenge. The orchestrator must accept that response.
    """

    def handler(req: httpx.Request) -> httpx.Response:
        assert "X-PAYMENT" not in req.headers
        return httpx.Response(200, json={"protocol": "swarmwage/v0.1", "free": True})

    transport = httpx.MockTransport(handler)
    with httpx.Client(transport=transport) as client:
        result = paid_request_json(
            client,
            Account.from_key(TEST_KEY),
            "https://seller.example/hire",
            allow_internal_endpoint=True,
            json_body={"protocol": "swarmwage/v0.1"},
            network="base",
            expected_seller_id=SELLER,
        )

    assert result.body == {"protocol": "swarmwage/v0.1", "free": True}
    assert result.settlement_tx_hash is None
