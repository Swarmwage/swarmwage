# License: MIT
# Tests for the SWARMWAGE_FACILITATOR env var opt-out (closes audit P0-2).
from __future__ import annotations

from unittest import mock

import pytest

from swarmwage import AgentClient, SWARMWAGE_FACILITATOR_URL
from swarmwage._payment import resolve_facilitator_url

_TEST_KEY = "0x" + "11" * 32


# ----------------------------------------------------------------------
# resolve_facilitator_url — env-var precedence (already correct in 0.3.0a0)
# ----------------------------------------------------------------------

@pytest.mark.parametrize("v", ["0", "false", "off", "no", "FALSE", "Off"])
def test_resolve_returns_none_when_env_var_disables(v: str) -> None:
    assert resolve_facilitator_url(env={"SWARMWAGE_FACILITATOR": v}) is None


def test_resolve_returns_default_when_env_unset() -> None:
    assert resolve_facilitator_url(env={}) == SWARMWAGE_FACILITATOR_URL


def test_resolve_returns_explicit_url_when_passed() -> None:
    out = resolve_facilitator_url(facilitator_url="https://custom.example.com")
    assert out == "https://custom.example.com"


# ----------------------------------------------------------------------
# AgentClient — actually READS the env (the P0 was the missing wiring)
# ----------------------------------------------------------------------

def test_agent_client_reads_env_var_disable() -> None:
    """Pre-fix bug: AgentClient called resolve_facilitator_url without
    `env=`, so the env var was silently ignored. Reverting the fix would
    make this test fail."""
    with mock.patch.dict("os.environ", {"SWARMWAGE_FACILITATOR": "0"}, clear=False):
        client = AgentClient(private_key=_TEST_KEY, telemetry=False)
        try:
            assert client.facilitator_url is None
        finally:
            client.close()


def test_agent_client_reads_env_var_off() -> None:
    with mock.patch.dict("os.environ", {"SWARMWAGE_FACILITATOR": "off"}, clear=False):
        client = AgentClient(private_key=_TEST_KEY, telemetry=False)
        try:
            assert client.facilitator_url is None
        finally:
            client.close()


def test_agent_client_default_when_env_unset() -> None:
    env = {k: v for k, v in __import__("os").environ.items() if k != "SWARMWAGE_FACILITATOR"}
    with mock.patch.dict("os.environ", env, clear=True):
        client = AgentClient(private_key=_TEST_KEY, telemetry=False)
        try:
            assert client.facilitator_url == SWARMWAGE_FACILITATOR_URL
        finally:
            client.close()


def test_agent_client_explicit_arg_overrides_default() -> None:
    client = AgentClient(
        private_key=_TEST_KEY,
        facilitator_url="https://my-own.example.com",
        telemetry=False,
    )
    try:
        assert client.facilitator_url == "https://my-own.example.com"
    finally:
        client.close()
