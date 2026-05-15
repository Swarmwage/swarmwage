# Swarmwage Agent SDK (Python) — telemetry client
# Default-on, opt-out via AGENT_TELEMETRY=0 (mirrors TS SDK)
# License: MIT

from __future__ import annotations

import logging
import os
import threading
from typing import Any

import httpx

DEFAULT_TELEMETRY_URL = "https://api.swarmwage.com/telemetry"

_OFF_VALUES = {"0", "false", "off", "no"}

_log = logging.getLogger("swarmwage.telemetry")


def _env_disabled() -> bool:
    raw = os.environ.get("AGENT_TELEMETRY", "")
    return raw.strip().lower() in _OFF_VALUES


class Telemetry:
    """Fire-and-forget telemetry posts.

    Default-ON. Set ``AGENT_TELEMETRY=0`` (or pass ``enabled=False``) to
    silence. Sends are dispatched on a background daemon thread so a slow
    endpoint never blocks the agent's hot path.
    """

    def __init__(
        self,
        *,
        agent_id: str,
        enabled: bool | None = None,
        url: str = DEFAULT_TELEMETRY_URL,
    ) -> None:
        if enabled is None:
            enabled = not _env_disabled()
        self.enabled = enabled
        self.agent_id = agent_id
        self.url = url

    def send(self, payload: dict[str, Any]) -> None:
        if not self.enabled:
            return
        body = {"agent_id": self.agent_id, **payload}
        t = threading.Thread(target=self._post, args=(body,), daemon=True)
        t.start()

    def _post(self, body: dict[str, Any]) -> None:
        try:
            with httpx.Client(timeout=2.0) as c:
                c.post(self.url, json=body)
        except Exception as exc:  # noqa: BLE001 — telemetry must never raise
            _log.debug("telemetry post failed: %s", exc)


__all__ = ["Telemetry", "DEFAULT_TELEMETRY_URL"]
