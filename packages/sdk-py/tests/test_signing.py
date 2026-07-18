# License: MIT
# Parity tests for the canonical Swarmwage signing scheme.
#
# Golden fixtures generated from the TypeScript reference implementation
# (packages/sdk-ts/src/wallet.ts `signTypedPayload`). A bit-flip on any of
# canonical-string / hash / signature here means the SDKs have diverged
# and a Python-signed payload will fail registry verification.
from __future__ import annotations

from swarmwage import (
    canonical_typed_payload,
    hash_typed_payload,
    sign_typed_payload,
)

_TEST_KEY = "0x" + "11" * 32
_TEST_AGENT_ID = "0x19e7e376e7c213b7e7e7e46cc70a5dd086daff2a"


def test_canonical_sorts_nested_keys_recursively() -> None:
    """Keys are sorted at EVERY nesting depth, so nested fields like
    `verification.all_passed` are part of the signed bytes. (The old scheme
    used a JS array replacer that silently dropped nested keys — the bug this
    canonicalizer fixes; the registry verifies with the same scheme.)"""
    payload = {
        "agent_id": "0xaa",
        "buyer": "0xbb",
        "verification": {"all_passed": True, "checks": {"schema_ok": True}},
        "amount_usdc_atomic": "100",
    }
    out = canonical_typed_payload(payload)
    assert out == (
        '{"agent_id":"0xaa","amount_usdc_atomic":"100","buyer":"0xbb",'
        '"verification":{"all_passed":true,"checks":{"schema_ok":true}}}'
    )


def test_receipt_payload_parity_with_ts_fixture() -> None:
    payload = {
        "protocol_version": "swarmwage/v0.1",
        "hire_id": "hire-fixture-001",
        "agent_id": _TEST_AGENT_ID,
        "buyer": "0x1234567890123456789012345678901234567890",
        "capability": "audio.transcribe.json-with-timestamps",
        "amount_usdc_atomic": "100000",
        "network": "base-sepolia",
        "tx_hash": "0x" + "ab" * 32,
        "completed_at": "2026-05-16T10:00:00.000Z",
        "verification": {"all_passed": True, "checks": {"schema_ok": True}},
    }
    expected_canonical = (
        '{"agent_id":"0x19e7e376e7c213b7e7e7e46cc70a5dd086daff2a",'
        '"amount_usdc_atomic":"100000",'
        '"buyer":"0x1234567890123456789012345678901234567890",'
        '"capability":"audio.transcribe.json-with-timestamps",'
        '"completed_at":"2026-05-16T10:00:00.000Z",'
        '"hire_id":"hire-fixture-001",'
        '"network":"base-sepolia",'
        '"protocol_version":"swarmwage/v0.1",'
        f'"tx_hash":"0x{"ab" * 32}",'
        '"verification":{"all_passed":true,"checks":{"schema_ok":true}}}'
    )
    assert canonical_typed_payload(payload) == expected_canonical

    expected_hash = "0x" + "".join(
        [
            "6d34a034034059c7",
            "2b47087cd3a87b70",
            "f41e6ff204de646f",
            "bc3d33b816b01291",
        ]
    )
    assert "0x" + hash_typed_payload(payload).hex() == expected_hash

    expected_sig = "0x" + "".join(
        [
            "6fc03b20518a5157",
            "9d1045c01a286b11",
            "4b1b6646c5c67c39",
            "2da98a572049bbaa",
            "1aa90876dddfeff7",
            "6a518b5c57d869a1",
            "bb9f04dc32ababde",
            "3b2fb8dcf56420b01b",
        ]
    )
    assert sign_typed_payload(_TEST_KEY, payload) == expected_sig


def test_listing_payload_parity_with_ts_fixture() -> None:
    listing = {
        "agent_id": _TEST_AGENT_ID,
        "capability": "image.generate.photorealistic.png",
        "price_usdc": "0.05",
        "currency": "USDC",
        "chain": "base",
        "max_latency_ms": 30000,
        "first_call_free": False,
        "endpoint": "https://example.com/hire",
    }
    expected_canonical = (
        '{"agent_id":"0x19e7e376e7c213b7e7e7e46cc70a5dd086daff2a",'
        '"capability":"image.generate.photorealistic.png",'
        '"chain":"base","currency":"USDC",'
        '"endpoint":"https://example.com/hire",'
        '"first_call_free":false,"max_latency_ms":30000,"price_usdc":"0.05"}'
    )
    assert canonical_typed_payload(listing) == expected_canonical
    expected_hash = (
        "0xeadd28643ff7ebe47281cc848c67dc4220ce188a126ea5bb54ef2e3da0f8177b"
    )
    assert "0x" + hash_typed_payload(listing).hex() == expected_hash
    expected_sig = (
        "0x75266b8734830136a5a0d5a818a620632e4bb5e1142916472c742ea3ac1aba29"
        "4fad3f2a4358667fea670f35c1b3ffbeb81549e00b5bd035cc68c453b971d3591c"
    )
    assert sign_typed_payload(_TEST_KEY, listing) == expected_sig


def test_endpoint_verify_payload_parity_with_ts_fixture() -> None:
    payload = {"agent_id": _TEST_AGENT_ID, "nonce": "abc123def456"}
    expected_canonical = (
        '{"agent_id":"0x19e7e376e7c213b7e7e7e46cc70a5dd086daff2a",'
        '"nonce":"abc123def456"}'
    )
    assert canonical_typed_payload(payload) == expected_canonical
    expected_sig = (
        "0xd88383a78ed9cd675573b3234f62ed612e749d43f390f860df273303ec9bc23e"
        "1af300cff52a000d7a9a8658f1b9403e3091d5395fb0819cf51752cb98b2d9ba1c"
    )
    assert sign_typed_payload(_TEST_KEY, payload) == expected_sig


def test_signature_includes_0x_prefix_and_is_65_bytes() -> None:
    sig = sign_typed_payload(_TEST_KEY, {"a": 1})
    assert sig.startswith("0x")
    # 65 bytes = 130 hex chars + "0x"
    assert len(sig) == 132


def test_sign_with_local_account_matches_string_key() -> None:
    """Passing a LocalAccount must produce the identical signature as
    passing the underlying private-key string."""
    from eth_account import Account

    payload = {"agent_id": _TEST_AGENT_ID, "nonce": "n"}
    acct = Account.from_key(_TEST_KEY)
    sig_a = sign_typed_payload(_TEST_KEY, payload)
    sig_b = sign_typed_payload(acct, payload)
    assert sig_a == sig_b


def test_unicode_key_and_value_preserved_in_canonical() -> None:
    """Both keys and string values must keep raw UTF-8 (no \\u escapes)
    so the keccak-over-UTF-8 stays consistent with the TS implementation."""
    payload = {"name": "résumé", "agent_id": "0xaa"}
    out = canonical_typed_payload(payload)
    assert "résumé" in out
    assert "\\u" not in out
