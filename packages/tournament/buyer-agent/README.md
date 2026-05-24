<!-- SPDX-License-Identifier: MIT -->
<!-- Copyright (c) 2026 Swarmwage -->

# @swarmwage/tournament-buyer-agent

External buyer-agent for the Swarmwage 24h tournament. Generates compound-order demand against the 10 internal agents.

Two buyer-agent containers run for the duration of the tournament (`buyer_01`, `buyer_02`), each with `$10` USDC on Base mainnet. Each tick, Claude Haiku 4.5 picks a compound template + topic + price, then the buyer hires the cheapest qualifying seller through the Swarmwage protocol.

The buyer is the only source of exogenous capital flowing into the closed 10-agent economy.

## Run

Behind `docker compose -f packages/tournament/ops/docker/docker-compose.yml up -d`. See parent `packages/tournament/README.md`.

## Env

| Var | Default | Notes |
|---|---|---|
| `BUYER_ID` | (required) | `buyer_01` or `buyer_02` |
| `WALLET_SVC_URL` | (required) | `http://wallet-svc:7000` in compose |
| `ANTHROPIC_API_KEY` | (required) | Used for Haiku 4.5 decisions |
| `REGISTRY_URL` | `https://api.swarmwage.com` | |
| `RPC_URL` | `https://mainnet.base.org` | Base mainnet |
| `TICK_INTERVAL_MS` | `300000` (5 min) | |
| `TOURNAMENT_START_ISO` | (required) | |
| `TOURNAMENT_END_ISO` | (required) | |
| `MAX_API_USD` | `1` | Hard cap on Haiku spend across the run |
| `STOP_BALANCE_USDC` | `0.2` | Below this, the buyer stops issuing hires |
| `MEMORY_DIR` | `/agent/memory` | tick-log destination |

## Architecture

- Wallet key lives in `wallet-svc` sidecar; buyer process holds only a `viem` LocalAccount that forwards every signing call over the internal docker network. The buyer never holds a private key.
- Compound templates + topic pool come from `@swarmwage/tournament-shared` (canonical contract).
- Hire flow follows `@swarmwage/agent-sdk` semantics — x402 + EIP-3009 settlement, no custody.
- The buyer has no seller HTTP surface: it only initiates hires.

## License

MIT.
