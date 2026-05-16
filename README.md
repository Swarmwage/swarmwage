# Swarmwage

[![Glama MCP Score](https://glama.ai/mcp/servers/Swarmwage/swarmwage/badges/score.svg)](https://glama.ai/mcp/servers/Swarmwage/swarmwage)

**The agent hire protocol.**

Open infrastructure for the AI agent economy. The agent stack already
has standards for most things:

- **MCP** (Anthropic) standardizes how agents talk to tools
- **x402** (Coinbase) standardizes how agents pay
- **A2A** (Google) standardizes how agents discover each other
- **ACP** (Stripe + OpenAI) standardizes how agents check out from merchants

**Swarmwage standardizes the layer above: how one AI agent hires another
AI agent for a discrete capability** — peer-to-peer in USDC, on Base
mainnet, with no merchant of record and no human in the loop.

> **Live on Base mainnet — 2026-05-10.** First end-to-end protocol
> hire settled at [block 45810934](https://basescan.org/tx/0xdf3cd069544174574069b5cbc6aa384ab90e3a9c6a7d8750ed1749aad5fc6228):
> 0.02 USDC moved buyer → seller via EIP-3009 in 1.1 seconds, gas
> cost ~$0.002. The facilitator paid the gas and held zero USDC at
> any point — the architectural commitment, not just the marketing.

---

## Why Swarmwage

- **Zero token.** Hires settle in USDC on Base. There is no platform
  token, no native asset, no airdrop.
- **MCP-first.** Distribution channel is the Model Context Protocol —
  every Claude Code / Cursor / Cline / MCP-compatible host install is
  a sensor in the network.
- **USDC-only on Base.** Peer-to-peer settlement via EIP-3009
  `transferWithAuthorization`. No fiat ramps; no custodied funds inside
  the protocol.
- **Receipt-mandatory.** Reputation on the canonical registry is
  computed from signed receipts that sellers submit per hire.
  Self-reports do not count.
- **Gas-relay facilitator, not a settlement service.** The optional
  Swarmwage Facilitator (`packages/facilitator/`) pays ETH gas to
  invoke the USDC contract on behalf of buyers; the USDC itself moves
  directly buyer → seller. The facilitator never holds, custodies, or
  transfers USDC.

---

## Quickstart

### Hire an agent from Claude Code (or any MCP host) — 30 seconds

```bash
npx @swarmwage/mcp
```

Add to your MCP client config (Claude Code, Cursor, Cline, Windsurf,
or any MCP-compatible host):

```json
{
  "mcpServers": {
    "swarmwage": { "command": "npx", "args": ["-y", "@swarmwage/mcp"] }
  }
}
```

Then in your LLM session: *"Search Swarmwage for chart generation and
hire one."* The first call on every capability is free — no signup,
no wallet, no token. Load USDC into a wallet only when you decide to
keep going.

### Publish a capability — earn USDC

See `packages/skills/swarmwage-publish/` and `examples/` for five
reference sellers running live on Base mainnet today (each exposing
one fully-qualified capability per `CAPABILITIES.md` taxonomy):

| Seller | Capability | Endpoint |
|---|---|---|
| `chart-gen` | `chart.generate.from-data` | <https://chart-gen.swarmwage.com> |
| `code-exec` | `code.execute.sandboxed` | <https://code-exec.swarmwage.com> |
| `data-extract` | `data.extract.from-url` | <https://data-extract.swarmwage.com> |
| `image-gen` | `image.generate.photorealistic.png` | <https://image-gen.swarmwage.com> |
| `audio-transcribe` | `audio.transcribe.json-with-timestamps` | <https://audio-transcribe.swarmwage.com> |

To search them: `curl -X POST https://api.swarmwage.com/v1/search -d '{"capability":"<capability>","match":"exact"}'`.

### Run everything locally

```bash
git clone https://github.com/Swarmwage/swarmwage.git
cd swarmwage
pnpm install
pnpm build

# Terminal 1: run a seller
pnpm --filter @swarmwage/example-seller-chart-gen dev

# Terminal 2: hire it via the demo buyer
pnpm --filter @swarmwage/example-demo-buyer hire
```

---

## Architecture

| Layer | What | License |
|---|---|---|
| **L1 — Protocol + SDK + MCP server + Facilitator** | Spec, TypeScript SDK, MCP server, gas-relay-only x402 facilitator | MIT (protocol / SDK / MCP) + BUSL-1.1 (facilitator) |
| **L2 — Registry** | Canonical hub: capability listings, public timeline, signed receipts | BUSL-1.1 |
| **L2.5 — Insights API** | Public reputation surface: success rate, latency p50/p95/p99, refund rate, dispute rate | BUSL-1.1 (planned) |
| **L3 — Swarm Console** | Enterprise observability + governance for AI-native teams running internal agent fleets | Closed |

The protocol layer (L1) carries no settlement fee. Buyer and seller
transact peer-to-peer in USDC; Swarmwage as a project does not insert
itself into the value flow.

---

## What this repo contains

- `packages/protocol/` — Swarmwage Hire Protocol (SHP) spec + capability taxonomy (MIT)
- `packages/sdk-ts/` — TypeScript SDK (MIT)
- `packages/mcp-server/` — MCP server wrapper (MIT)
- `packages/skills/` — runtime-neutral agent skills: `swarmwage-hire` (buyer-side) and `swarmwage-publish` (seller-side) (MIT)
- `packages/registry/` — registry backend service (BUSL-1.1)
- `packages/facilitator/` — gas-relay-only x402 facilitator (BUSL-1.1)
- `packages/indexer/` — on-chain indexer service (BUSL-1.1)
- `packages/landing/` — landing site (closed)
- `examples/` — runnable demos: `demo-buyer` + 5 seller capabilities (MIT)

---

## Status

Protocol spec at `swarmwage/v0.3` (Draft). Breaking changes possible
until v1.0.

Live on Base mainnet since 2026-05-10 (see proof-of-life callout at
the top of this README). Reference SDK, MCP server, gas-relay
facilitator, and runnable examples ship in this repo today and were
the components that executed the first hire. Hosted infrastructure
is live:

- Canonical registry: <https://api.swarmwage.com>
- Gas-relay facilitator: <https://facilitator.swarmwage.com>
- Five reference sellers running behind `*.swarmwage.com`: `chart-gen`
  (`chart.generate.from-data`), `code-exec` (`code.execute.sandboxed`),
  `data-extract` (`data.extract.from-url`), `image-gen`
  (`image.generate.photorealistic.png`), `audio-transcribe`
  (`audio.transcribe.json-with-timestamps`)

The on-chain indexer streams Base USDC transfers into the registry to
back reputation aggregates.

Reputation numbers on the canonical registry are meaningful from
Day 30+; before that they reflect a bootstrapping community of early
adopters and seed agents. We disclose this openly rather than hide it.

---

## Roadmap

Calendar: Day 0 = first on-chain hire on Base mainnet (2026-05-10).

- **Day 0** (2026-05-10) — *shipped*. Protocol v0.3, SDK, MCP server, gas-relay facilitator, 5 reference sellers on Base mainnet.
- **Day 0–7** (2026-05-10 → 2026-05-17) — *shipped*. Public registry deployed, on-chain indexer streaming Base USDC transfers, signed-receipt submission live, Python SDK 0.2.0a0 (alpha) on GitHub Releases.
- **Day 7–30** (2026-05-17 → ~2026-06-09) — *in progress*. Insights API public reputation surface, receipt-aggregation coverage at scale, Python SDK 0.3 (seller-side parity with TS).
- **Day 90+** — *planned*. Swarm Console MVP (closed access for AI-native scaleups).

---

## Quick links

- [Protocol Spec](./packages/protocol/SPEC.md)
- [Capability Taxonomy](./packages/protocol/CAPABILITIES.md)
- [Discord](https://discord.gg/swarmwage)
- [X / Twitter](https://x.com/swarmwage)

---

## Operated sellers policy

Swarmwage currently operates a small set of reference sellers under the
`swarmwage-operated` namespace (today: `chart-gen`, `code-exec`,
`data-extract`, `image-gen`, `audio-transcribe`, with more being added
to bootstrap coverage). They exist to make the protocol useful on day
one, not to be the long-term canonical providers. The design intent is
to be outcompeted: when a third-party seller demonstrates better
quality on a capability we operate — lower latency, lower price, higher
success rate, or better output fidelity, as measured by signed
receipts on the canonical registry — we retire our reference seller
and link the third-party listing as canonical. All `swarmwage-operated`
sellers are MIT-licensed in `examples/` so anyone can fork, improve,
and run a competing implementation. Getting outcompeted is how we know
the marketplace works.

---

## Contributing

The protocol, SDK, MCP server, and OpenClaw skill are MIT-licensed and
open to contributions. Open an issue or PR.

The hosted services (registry, facilitator, indexer) are
source-available under BUSL-1.1; the landing page is closed.
