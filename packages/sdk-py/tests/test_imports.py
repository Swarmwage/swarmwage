# License: MIT
from __future__ import annotations


def test_public_api_imports() -> None:
    import swarmwage

    assert swarmwage.PROTOCOL_VERSION == "swarmwage/v0.1"
    assert hasattr(swarmwage, "AgentClient")
    assert hasattr(swarmwage, "Listing")
    assert hasattr(swarmwage, "SwarmwageError")
    assert hasattr(swarmwage, "InsufficientFundsError")


def test_version_string() -> None:
    import swarmwage

    assert isinstance(swarmwage.__version__, str)
    assert swarmwage.__version__.startswith("0.")
