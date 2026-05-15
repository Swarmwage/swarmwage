# License: MIT
# Tests for the client-side capability verification helpers.
from __future__ import annotations

import base64

from swarmwage.verification import register_verifier, verify
from swarmwage.types import VerificationResult


PNG_MAGIC = b"\x89PNG\r\n\x1a\n" + b"\x00" * 8
PNG_B64 = base64.b64encode(PNG_MAGIC).decode("ascii")
JPEG_B64 = base64.b64encode(b"\xff\xd8\xff\xe0" + b"\x00" * 12).decode("ascii")


def test_chart_generate_from_data_happy_path() -> None:
    result = verify(
        "chart.generate.from-data",
        {
            "data": [{"x": "Mon", "y": 1}],
            "chart_type": "bar",
            "width": 800,
            "height": 600,
        },
        {
            "image_b64": PNG_B64,
            "width": 800,
            "height": 600,
            "chart_type": "bar",
        },
    )
    assert isinstance(result, VerificationResult)
    assert result.all_passed, [c.dict() for c in result.checks if not c.passed]


def test_chart_generate_dimension_mismatch_fails() -> None:
    result = verify(
        "chart.generate.from-data",
        {
            "data": [{"x": "Mon", "y": 1}],
            "chart_type": "bar",
            "width": 800,
            "height": 600,
        },
        {
            "image_b64": PNG_B64,
            "width": 400,
            "height": 600,
            "chart_type": "bar",
        },
    )
    assert not result.all_passed
    failed = {c.name for c in result.checks if not c.passed}
    assert "dimensions_match" in failed


def test_chart_generate_non_png_fails_magic() -> None:
    result = verify(
        "chart.generate.from-data",
        {
            "data": [{"x": "Mon", "y": 1}],
            "chart_type": "bar",
            "width": 800,
            "height": 600,
        },
        {
            "image_b64": JPEG_B64,
            "width": 800,
            "height": 600,
            "chart_type": "bar",
        },
    )
    assert not result.all_passed
    failed = {c.name for c in result.checks if not c.passed}
    assert "valid_png_magic" in failed


def test_unknown_capability_passes_through() -> None:
    result = verify("custom.unknown.thing", {"foo": 1}, {"bar": 2})
    assert result.all_passed
    assert result.checks[0].name == "no_verifier_registered"


def test_custom_verifier_overrides_builtin() -> None:
    register_verifier("chart.generate.from-data", lambda _i, _o: VerificationResult(checks=[], all_passed=False))
    result = verify("chart.generate.from-data", {}, {})
    assert not result.all_passed
