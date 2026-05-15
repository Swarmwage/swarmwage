# Swarmwage Agent SDK (Python) — client-side capability verification
# Mirrors packages/sdk-ts/src/verification.ts
# License: MIT
#
# Each verifier returns a :class:`VerificationResult`. The default ``verify``
# function dispatches by capability ID and falls back to a permissive
# ``no_verifier_registered`` pass-through so unknown capabilities never block
# a hire — sellers and the protocol are forward-compatible.

from __future__ import annotations

import base64
from typing import Any, Callable

from .types import VerificationCheck, VerificationResult

Verifier = Callable[[dict[str, Any], dict[str, Any]], VerificationResult]


def _check(name: str, passed: bool, detail: str | None = None) -> VerificationCheck:
    return VerificationCheck(name=name, passed=passed, detail=detail)


def _result(checks: list[VerificationCheck]) -> VerificationResult:
    return VerificationResult(
        checks=checks,
        all_passed=all(c.passed for c in checks),
    )


def _is_non_empty_str(v: Any) -> bool:
    return isinstance(v, str) and len(v) > 0


def _decode_b64_prefix(b64: str, n: int = 16) -> bytes:
    head = b64[: max(8, (n * 4 + 3) // 3)]
    head += "=" * ((4 - len(head) % 4) % 4)
    try:
        return base64.b64decode(head, validate=False)
    except (ValueError, TypeError):
        return b""


def _is_valid_image_magic(b64: Any) -> bool:
    if not isinstance(b64, str):
        return False
    prefix = _decode_b64_prefix(b64, 16)
    if prefix.startswith(b"\x89PNG"):
        return True
    if prefix.startswith(b"\xff\xd8\xff"):
        return True
    if prefix.startswith(b"RIFF") and prefix[8:12] == b"WEBP":
        return True
    if prefix.startswith(b"GIF87a") or prefix.startswith(b"GIF89a"):
        return True
    return False


def _is_valid_png(b64: Any) -> bool:
    if not isinstance(b64, str):
        return False
    return _decode_b64_prefix(b64, 8).startswith(b"\x89PNG")


# -------------------------------------------------------------------------
# Built-in verifiers
# -------------------------------------------------------------------------


def _verify_chart_generate_from_data(
    input_: dict[str, Any], output: dict[str, Any]
) -> VerificationResult:
    in_data = input_.get("data")
    in_type = input_.get("chart_type")
    checks = [
        _check("input_data_nonempty", isinstance(in_data, list) and len(in_data) > 0),
        _check("output_has_image_b64", isinstance(output.get("image_b64"), str)),
        _check("image_b64_nonempty", _is_non_empty_str(output.get("image_b64"))),
        _check(
            "dimensions_match",
            isinstance(output.get("width"), int)
            and isinstance(output.get("height"), int)
            and output.get("width") == input_.get("width")
            and output.get("height") == input_.get("height"),
        ),
        _check(
            "chart_type_match",
            isinstance(output.get("chart_type"), str)
            and output.get("chart_type") == in_type,
        ),
        _check("valid_png_magic", _is_valid_png(output.get("image_b64"))),
    ]
    return _result(checks)


def _verify_image_generate_photorealistic_png(
    input_: dict[str, Any], output: dict[str, Any]
) -> VerificationResult:
    checks = [
        _check("output_has_image_b64", isinstance(output.get("image_b64"), str)),
        _check("image_b64_nonempty", _is_non_empty_str(output.get("image_b64"))),
        _check(
            "dimensions_match",
            isinstance(output.get("width"), int)
            and isinstance(output.get("height"), int)
            and output.get("width") == input_.get("width")
            and output.get("height") == input_.get("height"),
        ),
        _check("valid_image_magic", _is_valid_image_magic(output.get("image_b64"))),
    ]
    return _result(checks)


def _verify_code_execute_sandboxed(
    input_: dict[str, Any], output: dict[str, Any]
) -> VerificationResult:
    requested = input_.get("timeout_ms")
    ceiling = int((requested if isinstance(requested, (int, float)) else 5000) * 1.25)
    dur = output.get("duration_ms")
    checks = [
        _check("output_has_stdout", isinstance(output.get("stdout"), str)),
        _check("output_has_stderr", isinstance(output.get("stderr"), str)),
        _check(
            "exit_code_is_int",
            isinstance(output.get("exit_code"), int)
            and not isinstance(output.get("exit_code"), bool),
        ),
        _check(
            "duration_within_timeout",
            isinstance(dur, (int, float)) and dur >= 0 and dur <= ceiling,
        ),
        _check("truncated_is_bool", isinstance(output.get("truncated"), bool)),
    ]
    return _result(checks)


_BUILTIN: dict[str, Verifier] = {
    "chart.generate.from-data": _verify_chart_generate_from_data,
    "image.generate.photorealistic.png": _verify_image_generate_photorealistic_png,
    "code.execute.sandboxed": _verify_code_execute_sandboxed,
}


_CUSTOM: dict[str, Verifier] = {}


def register_verifier(capability: str, verifier: Verifier) -> None:
    """Register a custom verifier for a capability ID (overrides builtin)."""
    _CUSTOM[capability] = verifier


def get_verifier(capability: str) -> Verifier | None:
    return _CUSTOM.get(capability) or _BUILTIN.get(capability)


def verify(
    capability: str,
    input_: dict[str, Any],
    output: dict[str, Any],
) -> VerificationResult:
    """Dispatch to the per-capability verifier. Unknown capabilities pass."""
    fn = get_verifier(capability)
    if fn is None:
        return _result([_check("no_verifier_registered", True)])
    return fn(input_, output)


__all__ = ["Verifier", "verify", "register_verifier", "get_verifier"]
