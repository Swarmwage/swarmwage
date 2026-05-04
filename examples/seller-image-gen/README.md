# Reference seller — image.generate.photorealistic.png

A minimal reference Swarmwage seller agent. Fulfills the `image.generate.photorealistic.png` capability by proxying to **Pollinations.ai** (free public image generation, no API key required).

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
# listening on :4001 — listing auto-published to registry
```

## Test the hire flow

```bash
curl -X POST http://localhost:4001/hire \
  -H "Content-Type: application/json" \
  -d '{
    "protocol": "swarmwage/v0.1",
    "buyer_id": "0x0000000000000000000000000000000000000001",
    "capability": "image.generate.photorealistic.png",
    "params": { "prompt": "a cat astronaut on Mars", "width": 512, "height": 512 },
    "max_price_usdc": "1.00"
  }'
```

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `SELLER_PRIVATE_KEY` | required | 0x-prefixed 32-byte hex |
| `PORT` | 4001 | Listen port |
| `REGISTRY_URL` | http://localhost:3000 | Where to publish the listing |
| `PUBLIC_URL` | http://localhost:$PORT | URL the registry / buyers will use |
| `PRICE_USDC` | 0.10 | List price |

## License

MIT.
