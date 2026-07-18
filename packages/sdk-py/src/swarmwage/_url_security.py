# Swarmwage Agent SDK (Python) — URL security guards
# License: MIT
#
# Defense-in-depth against SSRF: a malicious seller can publish a listing
# whose `endpoint` field points at an internal IP (cloud metadata,
# loopback, private RFC1918 range, link-local, multicast, reserved). The
# registry already filters obvious cases at validation time (Wave 1.5),
# but the buyer-side SDK must NOT blindly trust returned endpoint URLs —
# a registry compromise or a forgotten edge case would otherwise be a
# direct buyer-side data-leak path.
#
# We accept the small DNS-rebinding window (resolve → check → connect) as
# an explicit trade-off; closing it would require an HTTPS-only socket
# wrapper and DNS pinning, which is overkill for the alpha threat model.

from __future__ import annotations

import ipaddress
import socket
from urllib.parse import urlsplit

from .errors import TransportError

_ALLOWED_SCHEMES: frozenset[str] = frozenset(("http", "https"))


def _is_forbidden_ip(ip: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    """An IP is forbidden if it's not safely routable to a public host."""
    return (
        ip.is_loopback
        or ip.is_link_local        # 169.254.0.0/16 — AWS/GCP metadata, IPv6 fe80::/10
        or ip.is_private           # RFC1918 + RFC4193
        or ip.is_multicast
        or ip.is_reserved
        or ip.is_unspecified       # 0.0.0.0 / ::
    )


def _validate_host(host: str) -> None:
    """Reject the host if it resolves to a forbidden IP range."""
    if not host:
        raise TransportError("URL has empty host")
    # If `host` is a literal IP, check it directly.
    try:
        ip = ipaddress.ip_address(host.strip("[]"))
    except ValueError:
        ip = None
    if ip is not None:
        if _is_forbidden_ip(ip):
            raise TransportError(
                f"Refusing request to forbidden IP {host}: SDK blocks "
                "loopback, link-local, private, and reserved addresses to "
                "prevent SSRF via attacker-published endpoints"
            )
        return

    # Hostname — resolve and reject if ANY resolved IP is forbidden.
    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror as exc:
        raise TransportError(
            f"DNS resolution failed for host {host!r}: {exc}",
            cause=exc,
        ) from exc

    for info in infos:
        sockaddr = info[4]
        ip_str = sockaddr[0]
        try:
            resolved = ipaddress.ip_address(ip_str)
        except ValueError:
            continue
        if _is_forbidden_ip(resolved):
            raise TransportError(
                f"Refusing request to {host!r}: resolves to forbidden IP "
                f"{ip_str}. SDK blocks loopback, link-local, private, and "
                "reserved addresses to prevent SSRF via attacker-published "
                "endpoints."
            )


def _validate_basic_url(url: str) -> tuple[str, str]:
    """Common URL hygiene: scheme allowlist, no userinfo, host present.

    Returns (scheme, host). Raises TransportError on rejection.
    """
    if not isinstance(url, str) or not url:
        raise TransportError("URL must be a non-empty string")
    parts = urlsplit(url)
    scheme = (parts.scheme or "").lower()
    if scheme not in _ALLOWED_SCHEMES:
        raise TransportError(
            f"Refusing URL with scheme {scheme!r}: only http and https are "
            "allowed (blocks file://, gopher://, data://, etc.)"
        )
    # `userinfo` in a URL (`https://user:pass@host/path`) is a classic
    # phishing/redirection trick — browsers honor it but apps almost never
    # want it. Reject so a misconfigured `registry_url` can't covertly
    # route traffic to a different host.
    if parts.username is not None or parts.password is not None:
        raise TransportError(
            "Refusing URL with embedded userinfo: hostname must not be "
            "preceded by `user:pass@`"
        )
    host = parts.hostname or ""
    return scheme, host


def validate_seller_endpoint(url: str, *, allow_internal: bool = False) -> None:
    """Validate a seller-published endpoint URL before sending traffic to it.

    `allow_internal=True` is for tests only — production callers must
    always validate against the full forbidden-IP set. Raises
    `TransportError` on rejection.
    """
    _, host = _validate_basic_url(url)
    if allow_internal:
        return
    _validate_host(host)


def validate_registry_url(url: str) -> None:
    """Validate a buyer-configured registry URL.

    Same scheme + userinfo guards as seller endpoints. Host range is NOT
    checked (operators may legitimately point the SDK at an internal
    Swarmwage mirror), but scheme and userinfo are enforced.
    """
    _validate_basic_url(url)


__all__ = [
    "validate_seller_endpoint",
    "validate_registry_url",
]
