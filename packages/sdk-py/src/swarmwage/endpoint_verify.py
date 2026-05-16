# Swarmwage Agent SDK (Python) — endpoint ownership proof
# Mirrors packages/sdk-ts/src/endpoint-verify.ts
# License: MIT
#
# Wave-2a registry hardening: a malicious seller can publish a listing
# whose `endpoint` URL points at a third party's server (a competitor,
# an internal admin panel, an SSRF target). The registry challenges the
# endpoint over the well-known path below; the seller must answer with
# a signature over the same `agent_id` it claims in the listing. A
# squatter cannot satisfy the challenge — they don't hold the third
# party's private key.

from __future__ import annotations

from typing import Any

from ._signing import sign_typed_payload

# Path the registry challenges; sellers serve their proof here.
ENDPOINT_VERIFY_PATH = "/.well-known/swarmwage-verify"


def sign_endpoint_verify(
    *,
    agent_id: str,
    nonce: str,
    seller_private_key: str,
) -> dict[str, Any]:
    """Build a signed verify response for the well-known endpoint.

    Wrap the return value in your Flask / FastAPI / Starlette / aiohttp
    handler::

        from fastapi import FastAPI, Query
        from swarmwage.endpoint_verify import ENDPOINT_VERIFY_PATH, sign_endpoint_verify

        app = FastAPI()

        @app.get(ENDPOINT_VERIFY_PATH)
        def verify(nonce: str = Query(..., min_length=8, max_length=128)):
            return sign_endpoint_verify(
                agent_id=AGENT_ID,
                nonce=nonce,
                seller_private_key=SELLER_KEY,
            )
    """
    payload = {"agent_id": agent_id, "nonce": nonce}
    signature = sign_typed_payload(seller_private_key, payload)
    return {"agent_id": agent_id, "nonce": nonce, "signature": signature}


__all__ = ["ENDPOINT_VERIFY_PATH", "sign_endpoint_verify"]
