# @swarmwage/indexer

Read-only on-chain indexer for USDC `Transfer` events on Base. Captures the
canonical record of USDC volume flowing to addresses registered in the
Swarmwage registry, mapping each recipient address to its `agent_id`.

> **Read-only.** This service indexes public USDC `Transfer` events on Base.
> It does not custody, transfer, sign, or manage any funds. There is no
> signing key in this package's environment configuration and no write
> method on the imported USDC ABI fragment.

## Architecture

```
   Base USDC contract                       Swarmwage registry
     emits Transfer                          maps address → agent_id
        │                                            │
        ▼                                            ▼
  ┌──────────────┐    eth_getLogs      ┌────────────────────────┐
  │   public     │ ─────────────────▶  │   indexer loop         │
  │   RPC        │ ◀───────────────── │   (read-only)          │
  └──────────────┘                     └────────────────────────┘
                                                 │
                                                 ▼
                                       ┌────────────────────────┐
                                       │   IndexerStore         │
                                       │   (Postgres or mem)    │
                                       └────────────────────────┘
                                                 │
                                                 ▼
                                       Insights API + public stats
```

The indexer maintains a single per-chain cursor (`last_indexed_block`).
On each tick it asks the RPC for the chain head, computes the next range
to scan (capped by `MAX_BLOCK_RANGE`), fetches `Transfer` logs against the
USDC contract, resolves each recipient address against the registry, and
writes the rows to the store. The cursor advances atomically with the
write; restarting the indexer resumes exactly where it left off.

## Endpoints

| Method | Path        | Purpose                                                                       |
| ------ | ----------- | ----------------------------------------------------------------------------- |
| `GET`  | `/`         | Service identity                                                              |
| `GET`  | `/health`   | Liveness, current cursor, lag in blocks                                       |
| `GET`  | `/metrics`  | Aggregate counters: `transactions_total`, `last_indexed_block`, `lag_blocks`  |

## Environment variables

See [`.env.example`](./.env.example) for the complete list. All variables
have safe defaults for local development:

| Variable                  | Default                  | Description                                                              |
| ------------------------- | ------------------------ | ------------------------------------------------------------------------ |
| `PORT`                    | `3002`                   | HTTP listen port                                                         |
| `NETWORK`                 | `base-sepolia`           | One of `base`, `base-sepolia`                                            |
| `RPC_URL`                 | viem chain default       | JSON-RPC endpoint. Alchemy / QuickNode strongly recommended in prod.     |
| `REGISTRY_URL`            | `http://localhost:3010`  | Base URL of the Swarmwage registry                                       |
| `START_BLOCK`             | current head             | First block to index. Set explicitly to backfill history.                |
| `INDEX_INTERVAL_SECONDS`  | `60`                     | Seconds between idle ticks                                               |
| `MAX_BLOCK_RANGE`         | `2000`                   | Max blocks per `eth_getLogs` call                                        |
| `DATABASE_URL`            | unset (in-memory)        | Postgres connection string for the persistent store                      |
| `EXTERNAL_ADDRESSES_PATH` | unset (disabled)         | Path to a JSON seed of known external recipient addresses (see below)    |
| `LOG_LEVEL`               | `info`                   | One of `debug`, `info`, `warn`, `error`                                  |

## Run locally

```bash
pnpm install
cp packages/indexer/.env.example packages/indexer/.env
pnpm --filter @swarmwage/indexer dev
```

The service listens on `http://localhost:3002` by default. By default it
anchors at the current chain head and indexes only forward-going volume.
Set `START_BLOCK` to backfill from a specific block.

Smoke test (no RPC required):

```bash
pnpm --filter @swarmwage/indexer test
```

## Build

```bash
pnpm --filter @swarmwage/indexer build
pnpm --filter @swarmwage/indexer start
```

## Docker

```bash
docker build -f packages/indexer/Dockerfile -t swarmwage-indexer .
docker run --rm -p 3002:3002 \
  -e NETWORK=base-sepolia \
  -e REGISTRY_URL=https://registry.swarmwage.com \
  swarmwage-indexer
```

## External address attribution

By default the indexer tags each recipient against the Swarmwage registry
(`recipient_agent_id`). It can *additionally* attribute volume to known
**external** (non-Swarmwage) x402 endpoints — for example addresses sourced
from a public x402 catalog — without registering them as agents.

Point `EXTERNAL_ADDRESSES_PATH` at a JSON seed:

```json
[
  { "address": "0x...", "source": "example-catalog", "label": "Example Service", "category": "Search" }
]
```

Matching transfers are written with `recipient_source` / `recipient_label`
(distinct from `recipient_agent_id`). The dataset is operator-supplied and not
committed to this repository; the loader is a safe no-op when the path is unset
or the file is missing/malformed — external attribution MUST NEVER block
indexing. Query external volume with e.g.
`SELECT recipient_source, recipient_label, SUM(value_usdc_atomic) FROM transactions WHERE recipient_source IS NOT NULL GROUP BY 1, 2`.

## Operational notes

- The public viem RPC defaults are rate-limited and cap `eth_getLogs`
  ranges aggressively. For production deployments configure `RPC_URL`
  with an Alchemy, QuickNode, or Infura endpoint and tune
  `MAX_BLOCK_RANGE` accordingly. Alchemy's free tier accepts ranges up
  to 2000 blocks.
- The in-memory store is bounded and intended for local development
  only. Production deployments should connect a Postgres database that
  follows the schema in [`schema.sql`](./schema.sql).
- Transactions whose recipient is not registered are still indexed with
  `recipient_agent_id = null`. Backfilling the mapping later (e.g. when
  a seller registers an address) is a cheap UPDATE on the `to_address`
  index.
- **Database security**: the schema does not define RLS policies. The
  service connects via `DATABASE_URL` server-side with full privileges.
  No browser-side Supabase client is used; PostgREST is not exposed; the
  `anon` key is never deployed. If you ever wire one, add RLS first.

## License

Business Source License 1.1 — see [LICENSE](./LICENSE).
