# Swarmwage seller-chart-gen — matplotlib renderer
# License: MIT
#
# Long-running Python sidecar. Imports matplotlib once at boot, then reads
# JSONL render requests from stdin and writes JSONL responses to stdout.
# Ownership of the pipe is enforced by the TS parent (single-flight queue).
#
# Wire protocol (one JSON object per line):
#
#   parent → child   {"id": str, "title"?: str, "data": [{"x": str|int|float, "y": float}],
#                     "chart_type": "bar"|"line"|"pie",
#                     "width": int, "height": int,
#                     "x_label"?: str, "y_label"?: str, "theme"?: "light"|"dark",
#                     "seed"?: int}
#
#   child → parent   {"id": str, "ok": true, "image_b64": str,
#                     "width": int, "height": int, "chart_type": str}
#                  | {"id": str, "ok": false, "error": str}
#
# At boot the child writes a one-line ready signal: {"ready": true}.
#
# DPI is fixed at 100 so width/height passed in are pixels.

import base64
import io
import json
import sys
import traceback
from typing import Any

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt

DPI = 100
SUPPORTED_TYPES = {"bar", "line", "pie"}


def render(req: dict[str, Any]) -> dict[str, Any]:
    chart_type = req.get("chart_type")
    if chart_type not in SUPPORTED_TYPES:
        raise ValueError(f"unsupported chart_type: {chart_type!r}")

    data = req.get("data")
    if not isinstance(data, list) or len(data) == 0:
        raise ValueError("data must be a non-empty list")

    width = int(req["width"])
    height = int(req["height"])
    if width <= 0 or height <= 0 or width > 4096 or height > 4096:
        raise ValueError("width and height must be in (0, 4096]")

    xs: list[Any] = []
    ys: list[float] = []
    for i, point in enumerate(data):
        if not isinstance(point, dict) or "x" not in point or "y" not in point:
            raise ValueError(f"data[{i}] must be {{x, y}}")
        xs.append(point["x"])
        ys.append(float(point["y"]))

    theme = req.get("theme", "light")
    title = req.get("title")
    x_label = req.get("x_label")
    y_label = req.get("y_label")

    if theme == "dark":
        plt.style.use("dark_background")
        face = "#0a0807"
    else:
        plt.style.use("default")
        face = "#ffffff"

    fig, ax = plt.subplots(
        figsize=(width / DPI, height / DPI),
        dpi=DPI,
        facecolor=face,
    )
    ax.set_facecolor(face)

    accent = "#ff8c1a"

    if chart_type == "bar":
        ax.bar([str(x) for x in xs], ys, color=accent)
    elif chart_type == "line":
        ax.plot(xs, ys, color=accent, marker="o", linewidth=2)
    elif chart_type == "pie":
        ax.pie(ys, labels=[str(x) for x in xs], autopct="%1.1f%%")

    if title:
        ax.set_title(str(title))
    if x_label and chart_type != "pie":
        ax.set_xlabel(str(x_label))
    if y_label and chart_type != "pie":
        ax.set_ylabel(str(y_label))

    if chart_type != "pie":
        ax.grid(True, alpha=0.2)

    fig.tight_layout()

    buf = io.BytesIO()
    fig.savefig(buf, format="png", dpi=DPI, facecolor=face)
    plt.close(fig)

    image_b64 = base64.b64encode(buf.getvalue()).decode("ascii")
    return {
        "image_b64": image_b64,
        "width": width,
        "height": height,
        "chart_type": chart_type,
    }


def main() -> None:
    sys.stdout.write(json.dumps({"ready": True}) + "\n")
    sys.stdout.flush()

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        req_id = None
        try:
            req = json.loads(line)
            req_id = req.get("id")
            out = render(req)
            resp = {"id": req_id, "ok": True, **out}
        except Exception as exc:
            resp = {
                "id": req_id,
                "ok": False,
                "error": f"{type(exc).__name__}: {exc}",
                "trace": traceback.format_exc(limit=3),
            }
        sys.stdout.write(json.dumps(resp) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
