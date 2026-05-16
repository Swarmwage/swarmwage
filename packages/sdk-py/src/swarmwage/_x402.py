# Swarmwage Agent SDK (Python) — x402 protocol primitives
# Mirrors x402@1.2.0 (TypeScript) — schemes/exact/evm.
# License: MIT
#
# The x402 spec: a seller answers an unfunded request with HTTP 402 + a JSON
# body carrying one or more PaymentRequirements. The buyer picks one, prepares
# an EIP-3009 ``TransferWithAuthorization`` authorization, signs it with its
# wallet key, base64-encodes the resulting payload, and retries the request
# with an ``X-PAYMENT`` header. The seller verifies + settles via its
# facilitator and returns 200 with an ``X-PAYMENT-RESPONSE`` header containing
# the on-chain settlement transaction hash.
#
# This module owns the wire-level pieces (no HTTP, no retries — see
# :mod:`swarmwage._payment` for the orchestrator).

from __future__ import annotations

import base64
import json
import secrets
import time
from typing import Any, Iterable

from eth_account import Account
from eth_account.messages import encode_typed_data
from eth_account.signers.local import LocalAccount

X402_VERSION = 1
SCHEME_EXACT = "exact"

# Network → chain ID
EVM_NETWORK_TO_CHAIN_ID: dict[str, int] = {
    "base": 8453,
    "base-sepolia": 84532,
}

# chain ID → canonical USDC address (mirror of x402 v1.2 client/index.js)
USDC_ASSET_BY_CHAIN_ID: dict[int, str] = {
    8453: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    84532: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
}

# EIP-712 type definition for USDC transferWithAuthorization (EIP-3009).
AUTHORIZATION_TYPES: dict[str, list[dict[str, str]]] = {
    "TransferWithAuthorization": [
        {"name": "from", "type": "address"},
        {"name": "to", "type": "address"},
        {"name": "value", "type": "uint256"},
        {"name": "validAfter", "type": "uint256"},
        {"name": "validBefore", "type": "uint256"},
        {"name": "nonce", "type": "bytes32"},
    ],
}


def network_to_chain_id(network: str) -> int:
    try:
        return EVM_NETWORK_TO_CHAIN_ID[network]
    except KeyError as exc:
        raise ValueError(f"Unsupported x402 network: {network!r}") from exc


def usdc_address_for(network: str) -> str:
    return USDC_ASSET_BY_CHAIN_ID[network_to_chain_id(network)]


def create_nonce() -> str:
    """32 random bytes, 0x-prefixed lowercase hex (matches viem's `toHex`)."""
    return "0x" + secrets.token_hex(32)


# -------------------------------------------------------------------------
# PaymentRequirements selection
# -------------------------------------------------------------------------


def select_payment_requirements(
    accepts: Iterable[dict[str, Any]],
    *,
    network: str,
    scheme: str = SCHEME_EXACT,
) -> dict[str, Any]:
    """Pick the payment requirement matching ``(scheme, network)``, preferring
    a USDC asset on that network.

    Diverges intentionally from the upstream x402 helper, which silently
    falls back to the first listed requirement when nothing matches. The
    SDK refuses to sign for a different chain than the buyer configured —
    that would (a) burn an EIP-3009 authorization on the wrong network
    (recoverable only by waiting out validBefore), and (b) hide a real
    misconfiguration (buyer asked for `base`, seller only serves
    `base-sepolia`) behind a confusing partial success. Raise instead.
    """
    accepts_list = list(accepts)
    if not accepts_list:
        raise ValueError("x402: empty 'accepts' array in 402 challenge")

    broadly = [
        r for r in accepts_list
        if (not scheme or r.get("scheme") == scheme)
        and (not network or r.get("network") == network)
    ]
    if not broadly:
        offered = sorted({(r.get("scheme"), r.get("network")) for r in accepts_list})
        raise ValueError(
            f"x402: seller offers no requirement for (scheme={scheme!r}, "
            f"network={network!r}). Offered: {offered}. Refusing to sign on a "
            "different network than the buyer configured."
        )

    target_asset = USDC_ASSET_BY_CHAIN_ID.get(network_to_chain_id(network))
    usdc_only = [
        r for r in broadly
        if target_asset is not None
        and (r.get("asset") or "").lower() == target_asset.lower()
    ]
    return usdc_only[0] if usdc_only else broadly[0]


# -------------------------------------------------------------------------
# Payment header construction
# -------------------------------------------------------------------------


def prepare_payment_authorization(
    from_address: str,
    payment_requirements: dict[str, Any],
    *,
    now_ts: int | None = None,
    valid_before_skew_seconds: int | None = None,
    valid_after_skew_seconds: int = 600,
) -> dict[str, Any]:
    """Build an unsigned x402 ``payload.authorization`` dict.

    The ``validAfter`` field is set to (now - 600s) and ``validBefore`` to
    (now + ``maxTimeoutSeconds`` from the seller's requirements). All
    timestamps are decimal strings, matching the JSON wire format.
    """
    now = int(time.time() if now_ts is None else now_ts)
    skew = (
        valid_before_skew_seconds
        if valid_before_skew_seconds is not None
        else int(payment_requirements.get("maxTimeoutSeconds", 60))
    )
    valid_after = now - valid_after_skew_seconds
    valid_before = now + skew
    return {
        "from": from_address,
        "to": payment_requirements["payTo"],
        "value": str(payment_requirements["maxAmountRequired"]),
        "validAfter": str(valid_after),
        "validBefore": str(valid_before),
        "nonce": create_nonce(),
    }


def sign_authorization(
    account: LocalAccount,
    authorization: dict[str, Any],
    payment_requirements: dict[str, Any],
) -> str:
    """Sign an EIP-3009 ``TransferWithAuthorization`` and return the 0x-prefixed
    65-byte hex signature.
    """
    network = payment_requirements["network"]
    asset = payment_requirements["asset"]
    extra = payment_requirements.get("extra") or {}
    name = extra.get("name")
    version = extra.get("version")
    if name is None or version is None:
        raise ValueError(
            "x402: PaymentRequirements.extra must include EIP-712 'name' and "
            f"'version' (got name={name!r}, version={version!r})"
        )

    typed = {
        "types": AUTHORIZATION_TYPES,
        "domain": {
            "name": name,
            "version": version,
            "chainId": network_to_chain_id(network),
            "verifyingContract": asset,
        },
        "primaryType": "TransferWithAuthorization",
        "message": {
            "from": authorization["from"],
            "to": authorization["to"],
            "value": int(authorization["value"]),
            "validAfter": int(authorization["validAfter"]),
            "validBefore": int(authorization["validBefore"]),
            "nonce": authorization["nonce"],
        },
    }
    signable = encode_typed_data(full_message=typed)
    signed = account.sign_message(signable)
    return "0x" + signed.signature.hex()


def encode_payment(payment: dict[str, Any]) -> str:
    """Serialize a signed payment payload to the base64 ``X-PAYMENT`` header
    value. Matches ``x402.schemes.encodePayment``.
    """
    canonical = json.dumps(payment, separators=(",", ":"))
    return base64.b64encode(canonical.encode("utf-8")).decode("ascii")


def create_payment_header(
    account: LocalAccount,
    payment_requirements: dict[str, Any],
    *,
    x402_version: int = X402_VERSION,
    now_ts: int | None = None,
) -> tuple[str, dict[str, Any]]:
    """One-shot: prepare + sign + encode. Returns ``(header_value, payment)``.

    The second return is the canonical payment dict (useful for logging /
    asserting in tests).
    """
    authorization = prepare_payment_authorization(
        account.address,
        payment_requirements,
        now_ts=now_ts,
    )
    signature = sign_authorization(account, authorization, payment_requirements)
    payment = {
        "x402Version": x402_version,
        "scheme": payment_requirements["scheme"],
        "network": payment_requirements["network"],
        "payload": {
            "signature": signature,
            "authorization": authorization,
        },
    }
    return encode_payment(payment), payment


# -------------------------------------------------------------------------
# X-PAYMENT-RESPONSE decoding
# -------------------------------------------------------------------------


def decode_x_payment_response(header_value: str | None) -> dict[str, Any] | None:
    """Decode a seller-side ``X-PAYMENT-RESPONSE`` header.

    Returns ``None`` for missing or malformed headers — the SDK never raises
    on a bad post-settlement header; the absence is treated as "tx_hash
    unknown" so the response body remains the source of truth.
    """
    if not header_value:
        return None
    try:
        raw = base64.b64decode(header_value, validate=False).decode("utf-8")
        return json.loads(raw)
    except (ValueError, json.JSONDecodeError):
        return None


__all__ = [
    "X402_VERSION",
    "SCHEME_EXACT",
    "EVM_NETWORK_TO_CHAIN_ID",
    "USDC_ASSET_BY_CHAIN_ID",
    "AUTHORIZATION_TYPES",
    "network_to_chain_id",
    "usdc_address_for",
    "create_nonce",
    "select_payment_requirements",
    "prepare_payment_authorization",
    "sign_authorization",
    "encode_payment",
    "create_payment_header",
    "decode_x_payment_response",
]
