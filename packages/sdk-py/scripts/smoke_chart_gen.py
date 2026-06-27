#!/usr/bin/env python3
# Swarmwage Python SDK — Day-2 smoke test against chart-gen.swarmwage.com.
# License: MIT
#
# Usage:
#   BUYER_PRIVATE_KEY=0x... .venv/bin/python scripts/smoke_chart_gen.py
#
# What it does:
#   1. Generates a private key if none provided (lets you exercise the
#      first_call_free path without spending USDC).
#   2. Calls AgentClient.hire(capability="chart.generate.from-data") against
#      the canonical hosted seller. Forces seller selection by passing
#      agent_id + endpoint so search() doesn't need to match-and-fall-through.
#   3. Saves the rendered chart PNG to ./smoke-chart.png and prints the
#      Basescan link for the settlement transaction.
from __future__ import annotations

import base64
import os
import sys
import time

# Allow running from the package root without installing.
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "src"))

from eth_account import Account  # noqa: E402

from swarmwage import AgentClient, InsufficientFundsError, SellerMismatchError  # noqa: E402

CHART_GEN_ENDPOINT = "https://chart-gen.swarmwage.com"
# Seller agent_id learned from a prior probe — published listing on Base.
CHART_GEN_AGENT_ID = "0xfc6f3465ef7324756135bf6ace932d1d36748609"


def _secret_or_generate() -> tuple[str, bool]:
    secret = os.environ.get("BUYER_PRIVATE_KEY")
    if secret:
        return secret, False
    new = "0x" + os.urandom(32).hex()
    return new, True


def main() -> int:
    private_key, generated = _secret_or_generate()
    network = os.environ.get("NETWORK", "base")

    account = Account.from_key(private_key)
    print("=== Swarmwage py-sdk smoke — chart.generate.from-data ===")
    print(f"  buyer_id    : {account.address.lower()}")
    print(f"  network     : {network}")
    print(f"  key source  : {'GENERATED (fresh — expects first_call_free)' if generated else 'env BUYER_PRIVATE_KEY'}")
    print(f"  seller      : {CHART_GEN_AGENT_ID}")
    print(f"  endpoint    : {CHART_GEN_ENDPOINT}")
    print()

    client = AgentClient(
        private_key=private_key,
        network=network,
        telemetry=False,
    )

    params = {
        "title": "Swarmwage py-sdk Day-2 smoke",
        "chart_type": "bar",
        "data": [
            {"x": "Mon", "y": 12.4},
            {"x": "Tue", "y": 18.1},
            {"x": "Wed", "y": 22.7},
            {"x": "Thu", "y": 19.3},
            {"x": "Fri", "y": 28.5},
        ],
        "width": 1024,
        "height": 640,
        "x_label": "Day",
        "y_label": "USD",
        "theme": "dark",
    }

    t0 = time.monotonic()
    try:
        response = client.hire(
            capability="chart.generate.from-data",
            params=params,
            max_price_usdc="1.00",
            max_latency_ms=15_000,
            agent_id=CHART_GEN_AGENT_ID,
            endpoint=CHART_GEN_ENDPOINT,
        )
    except SellerMismatchError as exc:
        print(f"  FAIL — seller mismatch (anti-hijack guard): expected={exc.expected} actual={exc.actual}")
        return 2
    except InsufficientFundsError as exc:
        print(f"  FAIL — insufficient USDC: {exc}")
        return 3
    elapsed_ms = int((time.monotonic() - t0) * 1000)

    receipt = response.receipt
    image_b64 = response.result.get("image_b64", "")
    out_path = os.path.join(os.getcwd(), "smoke-chart.png")
    with open(out_path, "wb") as fh:
        fh.write(base64.b64decode(image_b64))

    print(f"  latency_ms      : {elapsed_ms}")
    print(f"  price_paid_usdc : {receipt.price_paid_usdc}")
    print(f"  receipt_id      : {receipt.receipt_id}")
    print(f"  seller_id       : {receipt.seller_id}")
    print(f"  tx_hash         : {receipt.tx_hash}")
    print(f"  verification    : {response.verification.all_passed}  ({len(response.verification.checks)} checks)")
    print(f"  png_saved       : {out_path}  ({len(image_b64) * 3 // 4:,} bytes decoded)")

    if receipt.tx_hash and receipt.tx_hash != "0x" + "0" * 64:
        explorer = "https://basescan.org/tx/" if network == "base" else "https://sepolia.basescan.org/tx/"
        print(f"  explorer        : {explorer}{receipt.tx_hash}")
    else:
        print("  explorer        : (no on-chain settlement — first_call_free path)")

    print()
    print("  status: OK")
    client.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
