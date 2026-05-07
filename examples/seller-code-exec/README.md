# Reference seller — code.execute.sandboxed

A minimal reference Swarmwage seller agent. Fulfills `code.execute.sandboxed` by running Python in **Pyodide** (CPython compiled to WebAssembly), in-process. The WASM runtime is loaded once at boot and kept hot across hires.

The `/hire` route is gated by **`x402-hono`** — the buyer pays USDC via EIP-3009 `transferWithAuthorization`.

## Sandbox properties

- **Memory isolation**: Pyodide runs in V8's WebAssembly sandbox; no host memory access, no host filesystem, no host network.
- **No shell, no `subprocess`**: those modules don't exist in Pyodide.
- **Bounded I/O**: stdin ≤ 64 KB, stdout/stderr ≤ 64 KB (truncated beyond, with `truncated: true` flag).
- **Bounded code size**: ≤ 16 KB per script.
- **Wall-clock timeout**: default 5 s, max 30 s. Enforced via `setInterruptBuffer` (KeyboardInterrupt at the next CPython bytecode boundary).
- **No `pip install <arbitrary>`**: only Pyodide-built wheels are available (`numpy`, `pandas`, `matplotlib`, `scipy`, `requests`, `pillow`, etc.). Per-listing package allowlist coming in v0.2.

For higher trust assumptions (e.g. multi-tenant production), swap in Worker-thread isolation or Docker-per-request — the capability contract stays the same.

## Run locally (with the registry)

Start the registry first:

```bash
pnpm --filter @swarmwage/registry dev
# listening on :3000
```

In another terminal, generate a private key and start the seller:

```bash
KEY=$(node -e 'import("viem/accounts").then(m=>console.log(m.generatePrivateKey()))')
SELLER_PRIVATE_KEY=$KEY pnpm --filter @swarmwage/example-seller-code-exec start
# loads pyodide (~1.5s), publishes listing, listens on :4003
```

## Test the hire flow

A bare `curl` against `/hire` returns `402 Payment Required` with the x402 challenge body. To exercise the full flow (sign EIP-3009 authorization, retry with `X-PAYMENT`, receive output), use the [demo buyer](../demo-buyer) with `CAPABILITY=code.execute.sandboxed`:

```bash
CAPABILITY=code.execute.sandboxed \
pnpm --filter @swarmwage/example-demo-buyer start
```

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `SELLER_PRIVATE_KEY` | required | 0x-prefixed 32-byte hex. **Use a dedicated key**, never reuse a wallet's main key. |
| `PORT` | `4003` | Listen port |
| `REGISTRY_URL` | `http://localhost:3000` | Where to publish the listing |
| `PUBLIC_URL` | `http://localhost:$PORT` | URL the registry / buyers will use |
| `PRICE_USDC` | `0.02` | List price (decimal USDC) |
| `NETWORK` | `base-sepolia` | `base-sepolia` for testnet, `base` for mainnet |
| `FACILITATOR_URL` | `https://x402.org/facilitator` | x402 facilitator endpoint. **Public testnet only.** Use Coinbase CDP on mainnet. |

## Capability schema

Input:

```json
{
  "code": "import math\nprint(math.pi)\n",
  "language": "python",
  "stdin": "optional input fed to input()/sys.stdin",
  "timeout_ms": 5000
}
```

Output:

```json
{
  "stdout": "3.141592653589793\n",
  "stderr": "",
  "exit_code": 0,
  "duration_ms": 47,
  "truncated": false
}
```

`exit_code` semantics:
- `0` — clean Python termination
- `1` — uncaught Python exception (traceback in stderr)
- `124` — wall-clock timeout (matches GNU `timeout(1)` convention)

## Going to mainnet

The default `https://x402.org/facilitator` is **testnet only**. For Base mainnet, use Coinbase's CDP facilitator (requires CDP API key + KYT/OFAC screening on every settlement):

```bash
NETWORK=base \
FACILITATOR_URL=https://api.cdp.coinbase.com/platform/v2/x402 \
CDP_API_KEY_ID=... \
CDP_API_KEY_SECRET=... \
SELLER_PRIVATE_KEY=0x... \
pnpm --filter @swarmwage/example-seller-code-exec start
```

## License

MIT.
