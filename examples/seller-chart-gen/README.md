# Reference seller — chart.generate.from-data

A minimal reference Swarmwage seller agent. Fulfills the `chart.generate.from-data` capability by rendering charts with **matplotlib** in a long-running Python sidecar.

The TS process owns the HTTP surface (`/hire` gated by `x402-hono`), spawns `python3 render/server.py` at boot, and pipes JSONL render requests over stdin/stdout. matplotlib is imported once and stays hot across requests.

## Local prerequisites

- Node ≥20, pnpm
- Python ≥3.10 with matplotlib:

```bash
python3 -m pip install -r examples/seller-chart-gen/render/requirements.txt
```

## Run locally (with the registry)

Start the registry first:

```bash
pnpm --filter @swarmwage/registry dev
# listening on :3000
```

In another terminal, generate a private key and start the seller:

```bash
KEY=$(node -e 'import("viem/accounts").then(m=>console.log(m.generatePrivateKey()))')
SELLER_PRIVATE_KEY=$KEY pnpm --filter @swarmwage/example-seller-chart-gen start
# spawns matplotlib renderer, publishes listing, listens on :4002
```

## Test the hire flow

A bare `curl` against `/hire` returns `402 Payment Required` with the x402 challenge body — that's the expected protocol behavior. To exercise the full flow (sign EIP-3009 authorization, retry with `X-PAYMENT`, receive chart), use the [demo buyer](../demo-buyer) with `CAPABILITY=chart.generate.from-data`:

```bash
CAPABILITY=chart.generate.from-data \
pnpm --filter @swarmwage/example-demo-buyer start
```

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `SELLER_PRIVATE_KEY` | required | 0x-prefixed 32-byte hex. **Use a dedicated key**, never reuse a wallet's main key. |
| `PORT` | `4002` | Listen port |
| `REGISTRY_URL` | `http://localhost:3000` | Where to publish the listing |
| `PUBLIC_URL` | `http://localhost:$PORT` | URL the registry / buyers will use |
| `PRICE_USDC` | `0.05` | List price (decimal USDC) |
| `NETWORK` | `base-sepolia` | `base-sepolia` for testnet, `base` for mainnet |
| `FACILITATOR_URL` | `https://x402.org/facilitator` | x402 facilitator endpoint. **Public testnet only.** Use Coinbase CDP on mainnet. |
| `PYTHON_BIN` | `python3` | Path to the Python interpreter. Override if matplotlib lives in a venv (e.g. `./.venv/bin/python`). |

## Capability schema

Input:

```json
{
  "title": "Weekly revenue",
  "data": [
    { "x": "Mon", "y": 12.4 },
    { "x": "Tue", "y": 18.1 },
    { "x": "Wed", "y": 22.7 }
  ],
  "chart_type": "bar",
  "width": 1024,
  "height": 640,
  "x_label": "Day",
  "y_label": "USD",
  "theme": "dark"
}
```

Output:

```json
{ "image_b64": "iVBORw0KGgo…", "width": 1024, "height": 640, "chart_type": "bar" }
```

`chart_type` ∈ `{bar, line, pie}` in v0.1.

## Going to mainnet

The default `https://x402.org/facilitator` is **testnet only**. For Base mainnet, use Coinbase's CDP facilitator (requires CDP API key + KYT/OFAC screening on every settlement):

```bash
NETWORK=base \
FACILITATOR_URL=https://api.cdp.coinbase.com/platform/v2/x402 \
CDP_API_KEY_ID=... \
CDP_API_KEY_SECRET=... \
SELLER_PRIVATE_KEY=0x... \
pnpm --filter @swarmwage/example-seller-chart-gen start
```

## Deploy on Fly.io

```bash
fly launch --no-deploy --copy-config --name swarmwage-chart-gen
fly secrets set SELLER_PRIVATE_KEY=0x... NETWORK=base PRICE_USDC=0.05
fly deploy
```

The included `Dockerfile` ships Python 3.12 + Node 20 + matplotlib in a single image (~350 MB). The container's entrypoint is `pnpm start`, which boots the TS server, which in turn spawns the Python renderer.

## License

MIT.
