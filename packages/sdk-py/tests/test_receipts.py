# License: MIT
# Tests for seller-side receipt submission.
from __future__ import annotations

import httpx
import pytest
from eth_account import Account

from swarmwage import (
    AgentClient,
    PROTOCOL_VERSION,
    ReceiptPayload,
    is_receipts_enabled,
    sign_receipt,
    submit_receipt,
)
from swarmwage._signing import sign_typed_payload

SELLER_KEY = "0x" + "33" * 32
SELLER_ID = Account.from_key(SELLER_KEY).address.lower()
BUYER_ID = "0x1234567890123456789012345678901234567890"


def _make_payload() -> ReceiptPayload:
    return ReceiptPayload(
        protocol_version=PROTOCOL_VERSION,
        hire_id="hire-test-001",
        agent_id=SELLER_ID,
        buyer=BUYER_ID,
        capability="audio.transcribe.json-with-timestamps",
        amount_usdc_atomic="100000",
        network="base-sepolia",
        tx_hash="0x" + "ab" * 32,
        completed_at="2026-05-16T10:00:00.000Z",
        verification={"all_passed": True, "checks": {"schema_ok": True}},
    )


def test_is_receipts_enabled_default_on() -> None:
    assert is_receipts_enabled(None, env={}) is True


@pytest.mark.parametrize("v", ["0", "false", "off", "no", "FALSE", "Off"])
def test_is_receipts_enabled_off_via_env(v: str) -> None:
    assert is_receipts_enabled(None, env={"SWARMWAGE_RECEIPTS": v}) is False


def test_is_receipts_enabled_explicit_overrides_env() -> None:
    assert is_receipts_enabled(True, env={"SWARMWAGE_RECEIPTS": "0"}) is True
    assert is_receipts_enabled(False, env={"SWARMWAGE_RECEIPTS": "1"}) is False


def test_sign_receipt_signature_validates_against_canonical_scheme() -> None:
    payload = _make_payload()
    body = sign_receipt(SELLER_KEY, payload)

    # Signature is just `sign_typed_payload(SELLER_KEY, payload.to_dict())`.
    expected_sig = sign_typed_payload(SELLER_KEY, payload.to_dict())
    assert body["signature"] == expected_sig
    # Body includes every field from payload + signature.
    for key in payload.to_dict():
        assert body[key] == payload.to_dict()[key]


def test_submit_receipt_disabled_skips_network() -> None:
    """When opted out we never even compose the request."""
    sent: list[httpx.Request] = []

    def handler(req: httpx.Request) -> httpx.Response:
        sent.append(req)
        return httpx.Response(200, json={"receipt_id": "ignored"})

    transport = httpx.MockTransport(handler)
    client = httpx.Client(transport=transport)
    try:
        result = submit_receipt(
            seller_private_key=SELLER_KEY,
            payload=_make_payload(),
            enabled=False,
            http_client=client,
        )
    finally:
        client.close()

    assert result.submitted is False
    assert sent == []


def test_submit_receipt_happy_path_posts_signed_body() -> None:
    captured: dict = {}

    def handler(req: httpx.Request) -> httpx.Response:
        captured["url"] = str(req.url)
        captured["body"] = req.content
        return httpx.Response(200, json={"receipt_id": "rcpt_abc", "ok": True})

    transport = httpx.MockTransport(handler)
    client = httpx.Client(transport=transport)
    try:
        result = submit_receipt(
            seller_private_key=SELLER_KEY,
            payload=_make_payload(),
            registry_url="https://api.swarmwage.com",
            http_client=client,
        )
    finally:
        client.close()

    assert result.submitted is True
    assert result.status == 200
    assert result.receipt_id == "rcpt_abc"
    assert result.error is None
    assert captured["url"] == "https://api.swarmwage.com/v1/receipts"
    # body is signed
    assert b'"signature":"0x' in captured["body"]


def test_submit_receipt_rejects_wallet_mismatch() -> None:
    sent: list[httpx.Request] = []

    def handler(req: httpx.Request) -> httpx.Response:
        sent.append(req)
        return httpx.Response(200)

    transport = httpx.MockTransport(handler)
    client = httpx.Client(transport=transport)
    payload = _make_payload()
    payload.agent_id = "0x" + "ff" * 20  # not the seller
    try:
        result = submit_receipt(
            seller_private_key=SELLER_KEY,
            payload=payload,
            http_client=client,
        )
    finally:
        client.close()

    # Mismatch is caught BEFORE the POST → no network call.
    assert sent == []
    assert result.submitted is True
    assert result.error is not None
    assert "does not match seller wallet" in result.error


def test_submit_receipt_swallows_4xx_and_logs() -> None:
    logs: list[str] = []

    def handler(req: httpx.Request) -> httpx.Response:
        return httpx.Response(400, text="bad receipt")

    transport = httpx.MockTransport(handler)
    client = httpx.Client(transport=transport)
    try:
        result = submit_receipt(
            seller_private_key=SELLER_KEY,
            payload=_make_payload(),
            http_client=client,
            logger=logs.append,
        )
    finally:
        client.close()

    assert result.submitted is True
    assert result.status == 400
    assert "bad receipt" in (result.error or "")
    assert any("400" in line for line in logs)


def test_submit_receipt_never_raises_on_network_error() -> None:
    logs: list[str] = []

    def handler(req: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused")

    transport = httpx.MockTransport(handler)
    client = httpx.Client(transport=transport)
    try:
        result = submit_receipt(
            seller_private_key=SELLER_KEY,
            payload=_make_payload(),
            http_client=client,
            logger=logs.append,
        )
    finally:
        client.close()

    assert result.submitted is True
    assert result.error is not None
    assert "network error" in result.error


def test_submit_receipt_rejects_dict_payload_missing_required_fields() -> None:
    """Audit P1: a dict payload missing required keys must NOT be signed
    and submitted as garbage. Caller bug should surface as a clear error."""
    sent: list = []

    def handler(req: httpx.Request) -> httpx.Response:
        sent.append(req)
        return httpx.Response(200, json={"receipt_id": "should_not_happen"})

    client = httpx.Client(transport=httpx.MockTransport(handler))
    try:
        result = submit_receipt(
            seller_private_key=SELLER_KEY,
            payload={"agent_id": SELLER_ID},  # everything else missing
            http_client=client,
        )
    finally:
        client.close()

    assert sent == []  # no network call
    assert result.submitted is True
    assert result.error is not None
    assert "missing required field" in result.error
    # Helpful surface: lists what was missing.
    assert "hire_id" in result.error


def test_submit_receipt_bad_private_key_narrow_exception() -> None:
    """Audit P1: bad key surfaces clearly; unrelated programming bugs
    (e.g. AttributeError on a wrong shape) should bubble up — not be
    swallowed under generic 'sign failed'."""
    logs: list[str] = []
    result = submit_receipt(
        seller_private_key="not-a-hex-key",  # ValueError from eth_account
        payload=_make_payload(),
        logger=logs.append,
    )
    assert result.submitted is True
    assert result.error is not None
    assert "bad private key" in result.error
    # Exception type name is included (binascii.Error / ValueError / TypeError)
    # so the seller can distinguish "bad key" from "registry rejected".
    assert ":" in result.error  # "<TypeName>: <msg>" surface


def test_agent_client_submit_receipt_uses_own_wallet() -> None:
    """AgentClient.submit_receipt fills in agent_id from the wallet."""
    captured: dict = {}

    def handler(req: httpx.Request) -> httpx.Response:
        captured["body"] = req.content
        return httpx.Response(200, json={"receipt_id": "rcpt_xyz"})

    client = AgentClient(private_key=SELLER_KEY, telemetry=False)
    # Swap the underlying httpx client for the mock transport.
    client._transport._client.close()
    client._transport._client = httpx.Client(transport=httpx.MockTransport(handler))
    try:
        result = client.submit_receipt(
            hire_id="hire-9",
            buyer=BUYER_ID,
            capability="audio.transcribe.json-with-timestamps",
            amount_usdc_atomic="50000",
            network="base",
            tx_hash="0x" + "cd" * 32,
            completed_at="2026-05-16T11:00:00.000Z",
            verification={"all_passed": True, "checks": {}},
        )
    finally:
        client.close()

    assert result.receipt_id == "rcpt_xyz"
    body_bytes = captured["body"]
    # The body should carry the SDK-owner's agent_id, not whatever the
    # caller might have passed (we don't let them pass it at all).
    assert SELLER_ID.encode() in body_bytes
