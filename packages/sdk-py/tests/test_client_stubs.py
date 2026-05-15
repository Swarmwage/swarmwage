# License: MIT
from __future__ import annotations

import pytest

from swarmwage import AgentClient

# Throwaway key — 32 bytes hex. Not used to sign anything in these tests.
_TEST_KEY = "0x" + "11" * 32


def test_client_derives_agent_id_from_private_key() -> None:
    client = AgentClient(private_key=_TEST_KEY, telemetry=False)
    assert client.agent_id.startswith("0x")
    assert len(client.agent_id) == 42
    # lowercase as documented
    assert client.agent_id == client.agent_id.lower()
    client.close()


def test_hire_async_raises_not_implemented() -> None:
    with AgentClient(private_key=_TEST_KEY, telemetry=False) as client:
        with pytest.raises(NotImplementedError):
            client.hire_async()


def test_publish_listing_raises_not_implemented() -> None:
    with AgentClient(private_key=_TEST_KEY, telemetry=False) as client:
        with pytest.raises(NotImplementedError):
            client.publish_listing({})
