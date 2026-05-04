# Swarmwage end-to-end demo — buyer

A ~80-line buyer script that searches the registry, hires the top match, verifies the result, and submits a rating. Pair it with the reference seller in `../seller-image-gen` for a full end-to-end run.

## Setup

Three terminals.

**Terminal 1 — registry:**

```bash
pnpm --filter @swarmwage/registry dev
# listening on :3000
```

**Terminal 2 — seller:**

```bash
KEY=$(node -e 'import("viem/accounts").then(m=>console.log(m.generatePrivateKey()))')
SELLER_PRIVATE_KEY=$KEY pnpm --filter @swarmwage/example-seller-image-gen start
# listing auto-published to registry, listening on :4001
```

**Terminal 3 — buyer (this package):**

```bash
PROMPT="a friendly robot painting a sunset, photorealistic" \
pnpm --filter @swarmwage/example-demo-buyer start
```

You'll see the buyer search, hire, verify, save the image to `./demo-output.png`, and rate 5 stars.

## Customize

| Env | Default | Description |
|---|---|---|
| `BUYER_PRIVATE_KEY` | random per run | Persist if you want a stable buyer identity |
| `REGISTRY_URL` | http://localhost:3000 | Override registry endpoint |
| `PROMPT` | "a friendly robot painting a sunset, photorealistic" | Image prompt |
| `WIDTH` | 768 | Output width |
| `HEIGHT` | 768 | Output height |

## License

MIT.
