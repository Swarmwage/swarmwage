# Swarmwage Agent SDK (Python) — canonicalization tests
# License: MIT
#
# Proves the deep canonicalization fix: nested fields are now signed, and the
# value domain is enforced. The cross-language byte-parity with the TS SDK is
# checked separately (see the canon-parity step).

import math

import pytest

from swarmwage._signing import CanonicalizationError, canonical_typed_payload

# Shared fixture — kept byte-identical to the TS canonical.test.ts fixture.
FIXTURE = {
    "protocol_version": "swarmwage/v0.1",
    "hire_id": "rcpt_abc",
    "agent_id": "0x1111111111111111111111111111111111111111",
    "buyer": "0x2222222222222222222222222222222222222222",
    "capability": "image.generate.photorealistic.png",
    "amount_usdc_atomic": "20000",
    "network": "base",
    "tx_hash": "0x" + "00" * 32,
    "completed_at": "2026-06-23T10:00:00.000Z",
    "max_latency_ms": 15000,
    "verification": {"all_passed": False, "checks": {"non_empty_result": True}},
}


def test_keys_sorted_recursively():
    assert canonical_typed_payload({"b": 1, "a": {"z": 1, "y": 2}}) == '{"a":{"y":2,"z":1},"b":1}'


def test_nested_verification_is_covered():
    # The whole point: flipping a NESTED field must change the signed bytes.
    base = canonical_typed_payload(FIXTURE)
    tampered = dict(FIXTURE)
    tampered["verification"] = {"all_passed": True, "checks": {"non_empty_result": True}}
    assert canonical_typed_payload(tampered) != base
    assert '"all_passed":false' in base
    assert '"all_passed":true' in canonical_typed_payload(tampered)


def test_rejects_float():
    with pytest.raises(CanonicalizationError):
        canonical_typed_payload({"x": 1.5})


def test_accepts_integer_valued_float_like_js():
    # JSON `1.0` parses to int 1 in JS (TS signs "1"); Python parses it to float
    # 1.0 — accept it as the integer so the same JSON body signs identically.
    assert canonical_typed_payload({"x": 1.0}) == '{"x":1}'


def test_rejects_nan_and_inf():
    with pytest.raises(CanonicalizationError):
        canonical_typed_payload({"x": math.nan})
    with pytest.raises(CanonicalizationError):
        canonical_typed_payload({"x": math.inf})


def test_rejects_non_string_key():
    with pytest.raises(CanonicalizationError):
        canonical_typed_payload({1: "x"})


def test_rejects_unsafe_integer():
    # > 2^53-1: JS would round it, diverging from Python's exact int.
    with pytest.raises(CanonicalizationError):
        canonical_typed_payload({"x": 9007199254740993})


def test_rejects_non_ascii_key():
    # JS sorts keys by UTF-16 code unit, Python by code point — diverges for
    # astral keys; enforce ASCII keys in both.
    with pytest.raises(CanonicalizationError):
        canonical_typed_payload({"é": 1})
    with pytest.raises(CanonicalizationError):
        canonical_typed_payload({"\U0001F600": 1})


def test_rejects_lone_surrogate_in_string_value():
    # TS escapes lone surrogates to \udXXX; Python can't UTF-8-encode them.
    # Reject in both so it's a domain error, not a silent divergence.
    with pytest.raises(CanonicalizationError):
        canonical_typed_payload({"x": "\ud800"})


def test_allows_astral_char_in_string_value():
    # Well-formed astral chars in VALUES are byte-identical across both SDKs.
    assert canonical_typed_payload({"x": "\U0001F600"}) == '{"x":"😀"}'


def test_integer_and_bool_and_null():
    assert canonical_typed_payload({"n": 0, "b": True, "z": None}) == '{"b":true,"n":0,"z":null}'
