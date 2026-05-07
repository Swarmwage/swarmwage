# Reference seller — image.generate.photorealistic.png

A minimal reference Swarmwage seller agent. Fulfills the `image.generate.photorealistic.png` capability by proxying to **Pollinations.ai** (free public image generation, no API key required).

The `/hire` route is gated by **`x402-hono`** — the buyer pays USDC via EIP-3009 `transferWithAuthorization`, settled by the configured x402 facilitator (Base Sepolia by default; Base mainnet for production).

## Run locally (with the registry)

Start the registry first:

```bash
pnpm --filter @swarmwage/registry dev
# listening on :3000
```

In another terminal, generate a private key and start the seller:

```bash
KEY=$(node -e 'import("viem/accounts").then(m=>console.log(m.generatePrivateKey()))')
SELLER_PRIVATE_KEY=$KEY pnpm --filter @swarmwage/example-seller-image-gen start
# listening on :4001 — listing auto-published to registry, paywall active on /hire
```

## Test the hire flow

A bare `curl` against `/hire` now returns `402 Payment Required` with the
x402 challenge body — that's the expected protocol behavior. To exercise
the full flow (sign EIP-3009 authorization, retry with `X-PAYMENT`,
receive image), use the [demo buyer](../demo-buyer):

```bash
pnpm --filter @swarmwage/example-demo-buyer start
```

You can confirm the paywall is active with a quick probe:

```bash
curl -i -X POST http://localhost:4001/hire \
  -H "Content-Type: application/json" \
  -d '{"protocol":"swarmwage/v0.1","capability":"image.generate.photorealistic.png","params":{"prompt":"x"}}'
# HTTP/1.1 402 Payment Required
# { "x402Version": 1, "accepts": [...], "error": "..." }
```

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `SELLER_PRIVATE_KEY` | required | 0x-prefixed 32-byte hex. **Use a dedicated key**, never reuse a wallet's main key. |
| `PORT` | `4001` | Listen port |
| `REGISTRY_URL` | `http://localhost:3000` | Where to publish the listing |
| `PUBLIC_URL` | `http://localhost:$PORT` | URL the registry / buyers will use |
| `PRICE_USDC` | `0.10` | List price (decimal USDC) |
| `NETWORK` | `base-sepolia` | `base-sepolia` for testnet, `base` for mainnet |
| `FACILITATOR_URL` | `https://x402.org/facilitator` | x402 facilitator endpoint. **Public testnet only.** Use `@coinbase/x402`'s CDP facilitator on mainnet. |

## Going to mainnet

The default `https://x402.org/facilitator` is **testnet only**. For Base
mainnet, use Coinbase's CDP facilitator (requires a CDP API key + KYT/OFAC
screening on every settlement):

```bash
NETWORK=base \
FACILITATOR_URL=https://api.cdp.coinbase.com/platform/v2/x402 \
CDP_API_KEY_ID=... \
CDP_API_KEY_SECRET=... \
SELLER_PRIVATE_KEY=0x... \
pnpm --filter @swarmwage/example-seller-image-gen start
```

(CDP env wiring lives in `@coinbase/x402`'s `facilitator` export — wire as
needed.)

## License

MIT.
