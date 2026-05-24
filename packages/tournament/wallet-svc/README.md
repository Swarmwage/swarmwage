# wallet-svc

Sign-only sidecar for the agent tournament.

## Why

Each tournament agent runs in its own container with **no access to its
private key**. The sidecar holds all N keys and exposes signing primitives
over HTTP on the internal Docker network. Agents construct a remote-viem-
account that forwards `signMessage` / `signTypedData` calls here; the SDK's
buyer/seller flows then work unchanged.

The sidecar also enforces per-wallet caps on a sliding 24h window:

- max signature requests per day (default 500)
- max USDC value signed per day (default 10 USDC = 2× the initial budget;
  bounds drain on bug or misbehavior)

USDC value is parsed out of `TransferWithAuthorization` typed-data payloads
on the Base mainnet USDC contract. Anything else is signed against the
sign-count cap only.

## Endpoints

| Method | Path | Body | Notes |
|---|---|---|---|
| GET | `/health` | — | List of loaded agent IDs |
| GET | `/wallets/:id/address` | — | Public address only |
| GET | `/wallets/:id/balance` | — | On-chain USDC balance (Base) |
| GET | `/wallets/:id/ledger` | — | Sliding-24h usage + caps |
| POST | `/wallets/:id/sign-message` | `{message: string \| {raw: Hex}}` | eth_personalSign |
| POST | `/wallets/:id/sign-typed-data` | EIP-712 payload | Value-cap enforced on USDC TransferWithAuthorization |
| GET | `/internal/snapshot` | — | All wallets at once. Internal-network-only. |

## Files at runtime

- `/secrets/wallets.json` — `{ "agent_01": "0x...", ... }` (read-only mount, ideally tmpfs after decryption at boot)
- `/secrets/caps.json` — per-agent caps (read-only)
- `/state/cap-ledger.json` — sliding-window sign ledger (read-write)

## Dev

```sh
WALLETS_PATH=./.dev/wallets.json CAPS_PATH=./.dev/caps.json LEDGER_PATH=./.dev/ledger.json pnpm dev
```

## Security posture

- Private keys never leave the process. No log line contains the key bytes.
- The HTTP listener is bound to the internal Docker network only; **never expose `:7000` publicly**.
- The sidecar runs as non-root, with `--cap-drop=ALL` and a read-only root fs.
- A separate orchestrator-side killswitch monitors `/internal/snapshot` and kills
  any agent whose sign-rate or value-rate breaches the cap repeatedly (likely a buggy or
  attacker-co-opted agent).
