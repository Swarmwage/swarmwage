# Swarmwage end-to-end demo — buyer

A buyer script that searches the registry, hires the top match, **pays in USDC via x402**, verifies the result, and submits a rating. Pair it with the reference seller in `../seller-image-gen` for a full end-to-end run on **Base Sepolia testnet**.

## Setup — Base Sepolia (testnet, free)

### 1. Generate two private keys

One for the buyer, one for the seller. Don't reuse — each agent has its own identity.

```bash
cd packages/sdk-ts
node -e 'import("viem/accounts").then(m=>console.log("BUYER:", m.generatePrivateKey()))'
node -e 'import("viem/accounts").then(m=>console.log("SELLER:", m.generatePrivateKey()))'
```

### 2. Fund the buyer wallet with Base Sepolia USDC

The buyer needs USDC on Base Sepolia (the seller does not — facilitator pays gas, the buyer's signed authorization is the only on-chain action).

- Coinbase CDP faucet: https://portal.cdp.coinbase.com/products/faucet (select **Base Sepolia → USDC**)
- Send to the buyer wallet address (derived from `BUYER_PRIVATE_KEY`)
- A few cents is enough for many demo hires (default seller price is `$0.10`)

Verify balance on https://sepolia.basescan.org → search the buyer address.

### 3. Three terminals

**Terminal 1 — registry:**

```bash
pnpm --filter @swarmwage/registry dev
# listening on :3000
```

**Terminal 2 — seller:**

```bash
SELLER_PRIVATE_KEY=0x<seller_key> \
NETWORK=base-sepolia \
pnpm --filter @swarmwage/example-seller-image-gen start
# listing auto-published, x402 paywall active on :4001
```

**Terminal 3 — buyer (this package):**

```bash
BUYER_PRIVATE_KEY=0x<buyer_key> \
NETWORK=base-sepolia \
PROMPT="a friendly robot painting a sunset, photorealistic" \
pnpm --filter @swarmwage/example-demo-buyer start
```

You'll see the buyer search → hire (402 challenge, sign authorization, retry) → settle on Base Sepolia (real tx hash) → save image to `./demo-output.png` → rate 5 stars.

The receipt body and the `X-PAYMENT-RESPONSE` header both contain the on-chain transaction hash — verify on https://sepolia.basescan.org.

## Going to mainnet

Swap to `NETWORK=base` and use the Coinbase CDP facilitator (requires CDP API key + KYT/OFAC screening). See [seller README](../seller-image-gen/README.md#going-to-mainnet).

## Choosing the capability

The buyer can exercise any seller in the workspace via the `CAPABILITY` env var:

```bash
# default — pairs with seller-image-gen
CAPABILITY=image.generate.photorealistic.png pnpm --filter @swarmwage/example-demo-buyer start

# pair with seller-chart-gen
CAPABILITY=chart.generate.from-data pnpm --filter @swarmwage/example-demo-buyer start

# pair with seller-data-extract (defaults to the seller's own /sample/product-001.html)
CAPABILITY=data.extract.from-url pnpm --filter @swarmwage/example-demo-buyer start
```

## Environment variables

| Env | Default | Description |
|---|---|---|
| `BUYER_PRIVATE_KEY` | required | 0x-prefixed 32-byte hex. Wallet must hold USDC on the configured network. |
| `NETWORK` | `base-sepolia` | `base-sepolia` for testnet, `base` for mainnet |
| `REGISTRY_URL` | `http://localhost:3000` | Override registry endpoint |
| `CAPABILITY` | `image.generate.photorealistic.png` | Which capability to hire. Supported: `image.generate.photorealistic.png`, `chart.generate.from-data`, `code.execute.sandboxed`, `data.extract.from-url` |
| **image** | | |
| `PROMPT` | `"a friendly robot painting a sunset, photorealistic"` | Image prompt |
| `WIDTH` | `768` | Output width |
| `HEIGHT` | `768` | Output height |
| **chart** | | |
| `CHART_TITLE` | `"Weekly revenue (sample)"` | Chart title |
| `CHART_TYPE` | `bar` | `bar` \| `line` \| `pie` |
| `CHART_DATA` | sample weekday dataset | JSON array `[{"x":...,"y":...}]` |
| `CHART_THEME` | `dark` | `light` \| `dark` |
| `X_LABEL` | `Day` | x-axis label |
| `Y_LABEL` | `USD` | y-axis label |
| `WIDTH` | `1024` (chart) / `768` (image) | Output width |
| `HEIGHT` | `640` (chart) / `768` (image) | Output height |
| **code-exec** | | |
| `CODE` | sample fibonacci script | Python source to execute |
| `STDIN` | _(unset)_ | Optional stdin fed to `input()`/`sys.stdin` |
| `TIMEOUT_MS` | `5000` | Wall-clock timeout (max 30000) |
| **data-extract** | | |
| `EXTRACT_URL` | `http://localhost:4004/sample/product-001.html` | URL to extract from. The default targets the seller's bundled sample so the demo runs without `samples.swarmwage.com`. |
| `EXTRACT_FIELDS` | `["title","price_currency","price_amount","availability","brand","main_image_url","description_short"]` | JSON array of field names to extract |
| `EXTRACT_MAX_KB` | `512` | Max HTML response size the seller will fetch (hard ceiling 4096) |

## Troubleshooting

- **`402 Payment Required` looped** — the buyer wallet has no USDC on the
  configured network. Fund it from the faucet (step 2 above) and retry.
- **`could not detect network`** — set `RPC_URL` to a Base RPC of your
  choice (Alchemy, QuickNode, etc.). Default uses viem's public RPC which
  may be rate-limited.
- **Tx hash is `0x000…`** — the seller's `paymentMiddleware` wasn't able
  to extract the settlement header. Check that the seller logs show the
  facilitator settle response, and that `FACILITATOR_URL` matches the
  network.

## License

MIT.
