# Swarmwage Agent SDK (Python) — canonical typed-payload signing
# Mirrors packages/sdk-ts/src/wallet.ts `signTypedPayload`.
# License: MIT
#
# The canonical scheme used by listings, receipts, and endpoint-verify
# proofs is intentionally simple and identical across SDK + registry:
#
#   canonical = JSON.stringify(payload, Object.keys(payload).sort())
#   hash      = keccak256(utf8_bytes(canonical))
#   signature = eth_personalSign(hash)            // EIP-191 over raw 32 bytes
#
# JS `JSON.stringify(value, replacerArray)` applies the replacer at EVERY
# nesting depth, so a top-level key list filters nested object keys too.
# We replicate that exactly so a Python-signed payload verifies identically
# on the (TypeScript) registry.
#
# Determinism caveat: the canonical key set is `Object.keys(payload).sort()`,
# i.e. only the TOP-LEVEL keys. Nested object keys not also present at the
# top level get dropped from the signed bytes — surprising but stable, and
# the TS implementation does the same. Tests pin this behavior.

from __future__ import annotations

import json
from typing import Any

from eth_account import Account
from eth_account.messages import encode_defunct
from eth_account.signers.local import LocalAccount
from eth_utils import keccak


def _restricted_dumps(value: Any, allowed: list[str]) -> str:
    """Replicate JS `JSON.stringify(value, allowed)` byte-for-byte."""
    if isinstance(value, dict):
        parts = []
        for k in allowed:
            if k in value:
                key_json = json.dumps(k, ensure_ascii=False)
                val_json = _restricted_dumps(value[k], allowed)
                parts.append(f"{key_json}:{val_json}")
        return "{" + ",".join(parts) + "}"
    if isinstance(value, list):
        return "[" + ",".join(_restricted_dumps(v, allowed) for v in value) + "]"
    # Primitives serialize identically to JS for our payload shapes.
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def canonical_typed_payload(payload: dict[str, Any]) -> str:
    """Return the canonical JSON string used as signing input."""
    allowed = sorted(payload.keys())
    return _restricted_dumps(payload, allowed)


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
    0x-prefixed 65-byte hex signature suitable for inclusion as a
    ``signature`` field on listings, receipts, and endpoint-verify
    responses.
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
    "canonical_typed_payload",
    "hash_typed_payload",
    "sign_typed_payload",
]
