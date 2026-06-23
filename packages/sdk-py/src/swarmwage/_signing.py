# Swarmwage Agent SDK (Python) — canonical typed-payload signing
# Mirrors packages/sdk-ts/src/canonical.ts `canonicalize`.
# License: MIT
#
# The canonical scheme used by listings, receipts, and endpoint-verify proofs:
#
#   canonical = deterministic JSON (keys sorted at EVERY level, compact)
#   hash      = keccak256(utf8_bytes(canonical))
#   signature = eth_personalSign(hash)            // EIP-191 over raw 32 bytes
#
# Object keys are sorted recursively so nested fields (e.g.
# `verification.all_passed`) are part of the signed bytes. The value domain is
# enforced (string, int, bool, None, list, dict only) so a disallowed value can
# never silently alter the signed bytes. Byte-identical to the TS SDK's
# `canonicalize`, so a Python-signed payload verifies on the TS registry.

from __future__ import annotations

import json
from typing import Any

from eth_account import Account
from eth_account.messages import encode_defunct
from eth_account.signers.local import LocalAccount
from eth_utils import keccak


class CanonicalizationError(ValueError):
    """A value outside the signed-payload domain was encountered."""


def _enc(v: Any) -> str:
    if v is None:
        return "null"
    if isinstance(v, bool):  # MUST precede int — bool is a subclass of int
        return "true" if v else "false"
    if isinstance(v, float):
        # JS has a single number type: JSON `1.0` parses to the number 1 and TS
        # signs it as "1". Mirror that — accept integer-valued floats, reject the
        # rest (NaN/Infinity have .is_integer() == False, so they fall through).
        if not v.is_integer():
            raise CanonicalizationError(f"non-integer number not allowed: {v!r}")
        v = int(v)
    if isinstance(v, int):
        # JS (float64) silently rounds integers above 2^53-1, so reject them here
        # too — otherwise a large Python int would sign different bytes than TS.
        if abs(v) > 2**53 - 1:
            raise CanonicalizationError(f"integer out of safe (±2^53-1) range: {v!r}")
        return str(v)
    if isinstance(v, str):
        # Lone surrogates can't encode to UTF-8 (TS escapes them to \udXXX
        # instead) — reject so the failure is a domain error, not a divergence.
        try:
            v.encode("utf-8")
        except UnicodeEncodeError:
            raise CanonicalizationError(
                "lone surrogate in string value not allowed"
            ) from None
        return json.dumps(v, ensure_ascii=False)
    if isinstance(v, (list, tuple)):
        return "[" + ",".join(_enc(e) for e in v) + "]"
    if isinstance(v, dict):
        # Validate keys BEFORE sorting: non-string keys would raise a raw
        # TypeError from sorted(); non-ASCII keys sort differently in JS (UTF-16
        # code unit) vs Python (code point) for astral chars. All protocol keys
        # are ASCII.
        for k in v.keys():
            if not isinstance(k, str):
                raise CanonicalizationError(f"non-string object key not allowed: {k!r}")
            if not k.isascii():
                raise CanonicalizationError(f"non-ASCII object key not allowed: {k!r}")
        parts = []
        for k in sorted(v.keys()):
            parts.append(json.dumps(k, ensure_ascii=False) + ":" + _enc(v[k]))
        return "{" + ",".join(parts) + "}"
    raise CanonicalizationError(f"unsupported value type: {type(v).__name__}")


def canonical_typed_payload(payload: dict[str, Any]) -> str:
    """Deterministic canonical JSON used as signing input (JCS subset).

    Keys are sorted at every level so nested fields are signed; the value domain
    is enforced. Byte-identical to the TypeScript SDK's ``canonicalize``.
    """
    return _enc(payload)


def hash_typed_payload(payload: dict[str, Any]) -> bytes:
    """Keccak256 of the canonical UTF-8 bytes — the 32-byte digest signed."""
    canonical = canonical_typed_payload(payload)
    return keccak(canonical.encode("utf-8"))


def sign_typed_payload(
    key_or_account: str | LocalAccount,
    payload: dict[str, Any],
) -> str:
    """Sign a typed payload with the canonical Swarmwage scheme.

    Accepts either a 0x-prefixed private-key string or an already-built
    ``LocalAccount`` (the ``AgentClient`` holds one of these). Returns a
    0x-prefixed 65-byte hex signature suitable for inclusion as a ``signature``
    field on listings, receipts, and endpoint-verify responses.
    """
    digest = hash_typed_payload(payload)
    message = encode_defunct(primitive=digest)
    if isinstance(key_or_account, LocalAccount):
        signed = key_or_account.sign_message(message)
    else:
        signed = Account.sign_message(message, private_key=key_or_account)
    sig_hex = signed.signature.hex()
    if not sig_hex.startswith("0x"):
        sig_hex = "0x" + sig_hex
    return sig_hex


__all__ = [
    "CanonicalizationError",
    "canonical_typed_payload",
    "hash_typed_payload",
    "sign_typed_payload",
]
