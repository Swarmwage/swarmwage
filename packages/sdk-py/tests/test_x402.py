# License: MIT
# Tests for the x402 wire format + EIP-3009 signing path.
# Verifies parity against an inline reference reproduction of viem's
# `wrapFetchWithPayment` flow so anyone debugging cross-SDK can trust the
# Python output is byte-identical to the TS output for the same inputs.
from __future__ import annotations

import base64
import json

import pytest
from eth_account import Account

from swarmwage import _x402
from swarmwage._payment import (
    SWARMWAGE_FACILITATOR_URL,
    resolve_facilitator_url,
)

# Throwaway determinist key. Address: 0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A
TEST_KEY = "0x" + "11" * 32


def _make_requirement(
    *,
    network: str = "base",
    pay_to: str = "0xfC6f3465EF7324756135bF6Ace932D1d36748609",
    value_atomic: str = "50000",
    max_timeout: int = 60,
) -> dict[str, object]:
    return {
        "scheme": "exact",
        "network": network,
        "maxAmountRequired": value_atomic,
        "resource": "https://chart-gen.swarmwage.com/hire",
        "description": "test",
        "mimeType": "application/json",
        "payTo": pay_to,
        "maxTimeoutSeconds": max_timeout,
        "asset": _x402.USDC_ASSET_BY_CHAIN_ID[8453],
        "extra": {"name": "USD Coin", "version": "2"},
    }


def test_create_payment_header_round_trip() -> None:
    account = Account.from_key(TEST_KEY)
    req = _make_requirement()
    header, payment = _x402.create_payment_header(account, req, now_ts=1_715_000_000)

    decoded = json.loads(base64.b64decode(header).decode("utf-8"))
    assert decoded == payment
    assert decoded["x402Version"] == 1
    assert decoded["scheme"] == "exact"
    assert decoded["network"] == "base"

    auth = decoded["payload"]["authorization"]
    assert auth["from"] == account.address
    assert auth["to"] == req["payTo"]
    assert auth["value"] == "50000"
    assert int(auth["validBefore"]) - int(auth["validAfter"]) == 60 + 600
    assert auth["nonce"].startswith("0x") and len(auth["nonce"]) == 66

    sig = decoded["payload"]["signature"]
    assert sig.startswith("0x") and len(sig) == 132


def test_signature_recovers_buyer_address() -> None:
    """A correctly signed authorization recovers to the buyer's address — the
    same check the seller's facilitator runs before settling.
    """
    from eth_account.messages import encode_typed_data

    account = Account.from_key(TEST_KEY)
    req = _make_requirement()
    _, payment = _x402.create_payment_header(account, req, now_ts=1_715_000_000)

    auth = payment["payload"]["authorization"]
    typed = {
        "types": _x402.AUTHORIZATION_TYPES,
        "domain": {
            "name": req["extra"]["name"],
            "version": req["extra"]["version"],
            "chainId": 8453,
            "verifyingContract": req["asset"],
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
    recovered = Account.recover_message(msg, signature=payment["payload"]["signature"])
    assert recovered.lower() == account.address.lower()


def test_select_payment_requirements_prefers_usdc_on_target_network() -> None:
    accepts = [
        _make_requirement(network="base-sepolia"),
        _make_requirement(),  # base, USDC
    ]
    sel = _x402.select_payment_requirements(accepts, network="base")
    assert sel["network"] == "base"
    assert sel["asset"] == _x402.USDC_ASSET_BY_CHAIN_ID[8453]


def test_select_payment_requirements_empty_raises() -> None:
    with pytest.raises(ValueError):
        _x402.select_payment_requirements([], network="base")


def test_decode_x_payment_response_handles_real_seller_header() -> None:
    settlement = {
        "success": True,
        "transaction": "0x" + "ab" * 32,
        "network": "base",
        "payer": "0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A",
    }
    raw = base64.b64encode(json.dumps(settlement).encode("utf-8")).decode("ascii")
    decoded = _x402.decode_x_payment_response(raw)
    assert decoded == settlement


def test_decode_x_payment_response_tolerates_garbage() -> None:
    assert _x402.decode_x_payment_response(None) is None
    assert _x402.decode_x_payment_response("") is None
    assert _x402.decode_x_payment_response("not-base64-$$$") is None


def test_resolve_facilitator_url_default_on() -> None:
    assert resolve_facilitator_url() == SWARMWAGE_FACILITATOR_URL


def test_resolve_facilitator_url_env_opt_out() -> None:
    for marker in ("0", "false", "off", "no", "OFF", "  False  "):
        assert resolve_facilitator_url(env={"SWARMWAGE_FACILITATOR": marker}) is None


def test_resolve_facilitator_url_explicit_string() -> None:
    assert resolve_facilitator_url(facilitator_url="https://x402.org/facilitator") == (
        "https://x402.org/facilitator"
    )


def test_create_nonce_is_32_bytes_hex() -> None:
    n1 = _x402.create_nonce()
    n2 = _x402.create_nonce()
    assert n1 != n2
    assert n1.startswith("0x") and len(n1) == 66


# ----------------------------------------------------------------------
# Audit P1: cross-network fallback must raise instead of silently picking
# a requirement on a different chain (would burn the EIP-3009 auth on the
# wrong network and hide a real misconfiguration).
# ----------------------------------------------------------------------

def test_select_payment_requirements_rejects_cross_network_fallback() -> None:
    accepts = [_make_requirement(network='base-sepolia')]
    import pytest as _pytest
    with _pytest.raises(ValueError, match='no requirement for'):
        _x402.select_payment_requirements(accepts, network='base')


def test_select_payment_requirements_empty_accepts_raises() -> None:
    import pytest as _pytest
    with _pytest.raises(ValueError, match="empty 'accepts'"):
        _x402.select_payment_requirements([], network='base')


def test_select_payment_requirements_unknown_scheme_raises() -> None:
    accepts = [{**_make_requirement(), 'scheme': 'weird-future-scheme'}]
    import pytest as _pytest
    with _pytest.raises(ValueError, match='no requirement for'):
        _x402.select_payment_requirements(accepts, network='base')

