# @swarmwage/facilitator

Reference x402 facilitator that broadcasts signed EIP-3009
`transferWithAuthorization` calls on USDC. The facilitator wallet pays ETH
for gas only.

> **Gas-relay only.** This service signs ETH-paid transactions that call
> `transferWithAuthorization()` on the deployed USDC contract using
> authorizations signed by the buyer. The USDC moves directly buyer → seller
> via the USDC contract. **The facilitator wallet never holds, custodies, or
> transfers USDC.** It is a relayer of pre-signed token transfers, not a
> payment processor and not a custodian.

## Architecture

```
   buyer signs                        facilitator broadcasts
   EIP-3009 auth                      (pays ETH for gas)
        │                                       │
        ▼                                       ▼
  ┌──────────────┐    POST /verify    ┌─────────────────┐
  │   x402       │ ─────────────────▶ │  /verify route  │
  │   client     │ ◀───────────────── │  (read-only)    │
  └──────────────┘                    └─────────────────┘
                                              │
                                              ▼
                                      ┌────────────────┐
                                      │ /settle route  │
                                      │ writeContract  │ ─── tx ──▶  USDC contract
                                      └────────────────┘                │
                                                                        ▼
                                                          USDC: from = buyer
                                                                to   = seller
                                                                value = signed
```

The flow that the facilitator participates in has three on-chain
characteristics:

1. The buyer signs an EIP-712 typed-data message authorising
   `transferWithAuthorization(from, to, value, validAfter, validBefore,
   nonce)` against the USDC contract's domain separator.
2. The facilitator submits a transaction that calls
   `USDC.transferWithAuthorization(...)` and supplies the signed (v, r, s).
   The facilitator pays the ETH gas. The transaction's `from` (= the gas
   wallet) is **not** the USDC `from`; the USDC contract enforces that the
   value moves from the address recovered from the signature.
3. USDC settlement is direct: buyer → seller.

## Endpoints

The HTTP surface implements the standard x402 facilitator interface
(v1.2 schemas).

| Method | Path | Purpose |
|---|---|---|
| `GET`  | `/`          | Service identity |
| `GET`  | `/health`    | Liveness + gas-wallet ETH balance |
| `GET`  | `/supported` | List of supported `(x402Version, scheme, network)` triples |
| `POST` | `/verify`    | Validate a signed authorization without broadcasting |
| `POST` | `/settle`    | Broadcast `USDC.transferWithAuthorization()` |

`/verify` and `/settle` accept the canonical x402 facilitator request body:

```jsonc
{
  "paymentPayload": { /* PaymentPayloadSchema from x402/types */ },
  "paymentRequirements": { /* PaymentRequirementsSchema from x402/types */ }
}
```

`/verify` returns `{ isValid, invalidReason?, payer? }`.
`/settle` returns `{ success, transaction, network, payer?, errorReason? }`.

## Environment variables

See [`.env.example`](./.env.example) for the complete list. Required:

| Variable | Description |
|---|---|
| `FACILITATOR_GAS_PRIVATE_KEY` | 0x-prefixed 32-byte hex key for the gas-paying wallet. |

Optional (with defaults):

| Variable | Default | Description |
|---|---|---|
| `PORT`         | `3001` | HTTP listen port |
| `NETWORK`      | `base-sepolia` | One of `base`, `base-sepolia` |
| `RPC_URL`      | viem chain default | JSON-RPC endpoint |
| `DATABASE_URL` | unset (in-memory) | Postgres connection string for the log store |
| `LOG_LEVEL`    | `info` | One of `debug`, `info`, `warn`, `error` |

## Run locally

```bash
pnpm install
cp packages/facilitator/.env.example packages/facilitator/.env
# Edit packages/facilitator/.env and set FACILITATOR_GAS_PRIVATE_KEY
pnpm --filter @swarmwage/facilitator dev
```

The service listens on `http://localhost:3001` by default.

Smoke test (no RPC required):

```bash
pnpm --filter @swarmwage/facilitator test
```

## Build

```bash
pnpm --filter @swarmwage/facilitator build
pnpm --filter @swarmwage/facilitator start
```

## Docker

```bash
docker build -f packages/facilitator/Dockerfile -t swarmwage-facilitator .
docker run --rm -p 3001:3001 \
  -e FACILITATOR_GAS_PRIVATE_KEY=0x... \
  -e NETWORK=base-sepolia \
  swarmwage-facilitator
```

## Operational notes

- Fund the gas wallet with native ETH on the target network. The wallet
  never receives or holds USDC.
- Each `/settle` broadcast consumes ETH proportional to the prevailing
  gas price on the target chain. Monitor `/health` for the wallet's
  remaining balance.
- The in-memory log store is intended for local development only.
  Production deployments should connect a Postgres database that follows
  the schema in [`schema.sql`](./schema.sql).
- **Database security**: the schema does not define RLS policies. The
  service connects via `DATABASE_URL` server-side with full privileges.
  No browser-side Supabase client is used; PostgREST is not exposed; the
  `anon` key is never deployed. `facilitator_logs` contains buyer
  signatures and EIP-3009 authorization fields — keep this DB
  service-role-only. If you ever wire a browser client, add RLS first
  AND consider redacting signatures on verify-only logs.

## License

Business Source License 1.1 — see [LICENSE](./LICENSE).
