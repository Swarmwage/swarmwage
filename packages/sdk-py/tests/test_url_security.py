# License: MIT
# Tests for SSRF / URL-injection defenses (closes Day-16 audit P0-1 + P1).
from __future__ import annotations

from unittest import mock

import httpx
import pytest

from swarmwage import AgentClient
from swarmwage._payment import paid_request_json
from swarmwage._transport import Transport
from swarmwage._url_security import (
    validate_registry_url,
    validate_seller_endpoint,
)
from swarmwage.errors import TransportError

_TEST_KEY = "0x" + "11" * 32


# ----------------------------------------------------------------------
# Scheme allowlist
# ----------------------------------------------------------------------

@pytest.mark.parametrize(
    "url",
    [
        "file:///etc/passwd",
        "gopher://evil.example.com/",
        "data:text/plain,hello",
        "ftp://evil.example.com/",
        "javascript:alert(1)",
    ],
)
def test_validate_seller_endpoint_rejects_non_http_schemes(url: str) -> None:
    with pytest.raises(TransportError, match="scheme"):
        validate_seller_endpoint(url)


def test_validate_seller_endpoint_rejects_userinfo() -> None:
    with pytest.raises(TransportError, match="userinfo"):
        validate_seller_endpoint("https://user:pass@public-host.example.com/hire")


def test_validate_seller_endpoint_rejects_empty() -> None:
    with pytest.raises(TransportError):
        validate_seller_endpoint("")


# ----------------------------------------------------------------------
# IP-range allowlist (the SSRF vector)
# ----------------------------------------------------------------------

@pytest.mark.parametrize(
    "ip",
    [
        "127.0.0.1",               # loopback
        "127.99.99.99",            # any 127/8
        "169.254.169.254",         # AWS / GCP metadata
        "10.0.0.1",                # RFC1918
        "172.16.0.1",              # RFC1918
        "192.168.1.1",             # RFC1918
        "0.0.0.0",                 # unspecified
        "224.0.0.1",               # multicast
        "::1",                     # IPv6 loopback
        "[::1]",                   # IPv6 loopback bracketed
    ],
)
def test_validate_seller_endpoint_rejects_internal_ip_literal(ip: str) -> None:
    host = ip if ip.startswith("[") else (f"[{ip}]" if ":" in ip else ip)
    with pytest.raises(TransportError, match="forbidden IP"):
        validate_seller_endpoint(f"http://{host}/hire")


def test_validate_seller_endpoint_allows_public_ip_literal() -> None:
    # Cloudflare DNS — public, safe to reach.
    validate_seller_endpoint("http://1.1.1.1/hire")


def test_validate_seller_endpoint_rejects_hostname_resolving_to_internal() -> None:
    """Even when the URL has a hostname, the resolved IP is checked."""
    fake_addr = (None, None, None, "", ("169.254.169.254", 0))
    with mock.patch("swarmwage._url_security.socket.getaddrinfo", return_value=[fake_addr]):
        with pytest.raises(TransportError, match="resolves to forbidden IP"):
            validate_seller_endpoint("http://attacker-controlled.example.com/hire")


def test_validate_seller_endpoint_dns_failure_surfaces_clean_error() -> None:
    import socket as _sock
    with mock.patch(
        "swarmwage._url_security.socket.getaddrinfo",
        side_effect=_sock.gaierror(-2, "Name or service not known"),
    ):
        with pytest.raises(TransportError, match="DNS resolution failed"):
            validate_seller_endpoint("http://does-not-exist.invalid/hire")


def test_allow_internal_endpoint_bypass_for_tests() -> None:
    """Tests may opt into hitting internal hosts; production never does."""
    validate_seller_endpoint("http://127.0.0.1:8080/hire", allow_internal=True)


# ----------------------------------------------------------------------
# Registry-URL guard (defense vs userinfo phishing in buyer-config)
# ----------------------------------------------------------------------

def test_validate_registry_url_rejects_userinfo() -> None:
    with pytest.raises(TransportError, match="userinfo"):
        validate_registry_url("https://api.swarmwage.com@evil.com/")


def test_validate_registry_url_rejects_non_http_scheme() -> None:
    with pytest.raises(TransportError, match="scheme"):
        validate_registry_url("ftp://api.swarmwage.com/")


def test_validate_registry_url_allows_internal_hosts() -> None:
    """Operators may legitimately point at a Swarmwage mirror on a private
    network — the registry-URL guard does NOT block IP ranges."""
    validate_registry_url("https://10.0.0.5:8443/")


def test_transport_init_validates_registry_url() -> None:
    with pytest.raises(TransportError, match="userinfo"):
        Transport("https://api.swarmwage.com@evil.com/")


def test_agent_client_init_rejects_userinfo_registry_url() -> None:
    with pytest.raises(TransportError):
        AgentClient(
            private_key=_TEST_KEY,
            registry_url="https://api.swarmwage.com@evil.com/",
            telemetry=False,
        )


# ----------------------------------------------------------------------
# End-to-end: paid_request_json refuses the SSRF target before any POST
# ----------------------------------------------------------------------

def test_paid_request_refuses_loopback_endpoint() -> None:
    """The buyer's body must never reach 127.0.0.1 even if a seller
    publishes it. This is the core P0 from the audit."""
    from eth_account import Account

    sent: list = []

    def handler(req: httpx.Request) -> httpx.Response:
        sent.append(req)
        return httpx.Response(200, json={"ok": True})

    client = httpx.Client(transport=httpx.MockTransport(handler))
    try:
        with pytest.raises(TransportError, match="forbidden IP"):
            paid_request_json(
                client,
                Account.from_key(_TEST_KEY),
                "http://127.0.0.1:9999/hire",
                json_body={"buyer": "secret"},
                network="base",
            )
    finally:
        client.close()

    # CRITICAL: no request ever fired. The buyer's body never left.
    assert sent == []


def test_paid_request_refuses_aws_metadata_endpoint() -> None:
    from eth_account import Account

    sent: list = []
    transport = httpx.MockTransport(lambda req: (sent.append(req), httpx.Response(200))[1])
    client = httpx.Client(transport=transport)
    try:
        with pytest.raises(TransportError, match="forbidden IP"):
            paid_request_json(
                client,
                Account.from_key(_TEST_KEY),
                "http://169.254.169.254/latest/meta-data/iam/security-credentials/",
                json_body={"buyer": "secret"},
                network="base",
            )
    finally:
        client.close()
    assert sent == []
