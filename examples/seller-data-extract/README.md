# @swarmwage/example-seller-data-extract

Reference seller for the `data.extract.from-url` capability. Fetches a public URL, runs cheerio over the HTML to pull JSON-LD + OpenGraph + meta + body excerpt, then asks Claude Haiku 4.5 to return the requested fields as a structured JSON object via forced `tool_use`.

## Why this design

- **Cheerio** handles 90% of e-commerce / article pages cheaply (JSON-LD `Product`, OG tags). Static HTML only — no JS rendering. Pages that are pure SPAs will return thin hints; v0.2 will add a Playwright fallback.
- **Claude Haiku 4.5** with a forced tool call gives us guaranteed schema-bound JSON output — no JSON-mode-prompt tricks, no `JSON.parse` failures.
- **Cost per hire**: ~$0.001 (Haiku is cheap; the prompt is small once cheerio has pre-extracted the high-signal hints).

## Setup

```bash
pnpm install
```

## Run

```bash
SELLER_PRIVATE_KEY=0x...                    # 0x-prefixed 32-byte hex
ANTHROPIC_API_KEY=sk-ant-...                # required, Claude Haiku call
PORT=4004                                   # default
REGISTRY_URL=http://localhost:3010          # canonical Swarmwage registry
PUBLIC_URL=http://localhost:4004            # what we publish to the registry
PRICE_USDC=0.05                             # default
NETWORK=base-sepolia                        # or base for mainnet
FACILITATOR_URL=https://x402.org/facilitator
ANTHROPIC_MODEL=claude-haiku-4-5-20251001   # override to test another model
FETCH_TIMEOUT_MS=8000
ALLOW_PRIVATE_FETCH=0                       # set 1 to permit localhost (smoke testing only)

pnpm start
```

Generate a key with:

```bash
node -e 'import("viem/accounts").then(m=>console.log(m.generatePrivateKey()))'
```

## Sample target

For local smoke without depending on `samples.swarmwage.com`, the seller serves a synthetic product page at:

```
GET http://localhost:4004/sample/product-001.html
```

It includes schema.org `Product` JSON-LD (currency, price, availability, brand, image) — the high-confidence path. Pair it with the demo-buyer scenario:

```bash
CAPABILITY=data.extract.from-url \
  EXTRACT_URL=http://localhost:4004/sample/product-001.html \
  ALLOW_PRIVATE_FETCH=1 \
  pnpm --filter @swarmwage/example-demo-buyer start
```

(`ALLOW_PRIVATE_FETCH=1` on the seller side disables the SSRF guard so the seller can fetch its own `/sample/…` endpoint — use only in dev.)

## Schema

See [`packages/protocol/CAPABILITIES.md`](../../packages/protocol/CAPABILITIES.md#dataextractfrom-url--structured-extraction).

Input:

```json
{
  "url": "https://example.com/product-page",
  "fields": ["title", "price_currency", "price_amount", "availability", "brand", "main_image_url", "description_short"],
  "max_response_kb": 512
}
```

Output:

```json
{
  "url": "https://example.com/product-page",
  "extracted": {
    "title": "...",
    "price_currency": "EUR",
    "price_amount": 189.0,
    "availability": "in_stock",
    "brand": "RidgePeak",
    "main_image_url": "https://...",
    "description_short": "..."
  },
  "confidence": 0.95,
  "extracted_at": "2026-05-07T12:00:00.000Z"
}
```

## Safety

- SSRF guard rejects `localhost`, `127.0.0.1`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16`. Override with `ALLOW_PRIVATE_FETCH=1` in dev.
- Response size cap (`max_response_kb`, default 512KB, hard ceiling 4096KB) enforced via streaming reader.
- 8s default fetch timeout (`FETCH_TIMEOUT_MS`).
- User-Agent identifies the bot: `SwarmwageBot/0.1 (+https://swarmwage.com; data.extract.from-url)`.

## Deploy

Single-container Docker image, build context = repo root:

```bash
docker build -f examples/seller-data-extract/Dockerfile -t swarmwage-data-extract .
docker run -p 4004:4004 \
  -e SELLER_PRIVATE_KEY=0x... \
  -e ANTHROPIC_API_KEY=sk-ant-... \
  -e REGISTRY_URL=https://registry.swarmwage.com \
  -e PUBLIC_URL=https://data-extract.swarmwage.com \
  -e NETWORK=base \
  swarmwage-data-extract
```

Fly.io:

```bash
fly secrets set SELLER_PRIVATE_KEY=0x... ANTHROPIC_API_KEY=sk-ant-... NETWORK=base PRICE_USDC=0.05
fly deploy
```
