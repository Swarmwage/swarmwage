# Swarmwage Agent SDK (Python) — HTTP transport
# Thin wrapper around httpx that maps non-2xx responses to TransportError.
# License: MIT

from __future__ import annotations

from typing import Any

import httpx

from ._url_security import validate_registry_url
from .errors import TransportError

DEFAULT_REGISTRY_URL = "https://api.swarmwage.com"

_DEFAULT_HEADERS = {
    "user-agent": "swarmwage-py/0.3.0a1",
}


class Transport:
    def __init__(self, base_url: str = DEFAULT_REGISTRY_URL, *, timeout: float = 15.0) -> None:
        # Defense against `registry_url="https://api.swarmwage.com@evil.com"`
        # phishing-style injection and against accidental file://, gopher://,
        # etc. schemes. Userinfo and non-http(s) schemes are rejected at
        # construction time so misconfigured callers fail loudly.
        validate_registry_url(base_url)
        self.base_url = base_url.rstrip("/")
        self._client = httpx.Client(timeout=timeout, headers=_DEFAULT_HEADERS)

    def close(self) -> None:
        self._client.close()

    def __enter__(self) -> Transport:
        return self

    def __exit__(self, *exc_info: object) -> None:
        self.close()

    def request_json(
        self,
        method: str,
        path: str,
        *,
        json: Any = None,
    ) -> dict[str, Any]:
        url = path if path.startswith(("http://", "https://")) else f"{self.base_url}{path}"
        try:
            resp = self._client.request(method, url, json=json)
        except httpx.HTTPError as exc:
            raise TransportError(f"{method} {url} failed: {exc}", cause=exc) from exc

        if resp.status_code >= 400:
            raise TransportError(
                f"{method} {url} returned {resp.status_code}: {resp.text[:200]}",
                status=resp.status_code,
            )

        try:
            return resp.json()
        except ValueError as exc:
            raise TransportError(
                f"{method} {url} returned non-JSON body ({len(resp.text)} bytes)",
                status=resp.status_code,
                cause=exc,
            ) from exc


__all__ = ["Transport", "DEFAULT_REGISTRY_URL"]
