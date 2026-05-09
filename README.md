# Swarmwage

**The standard infrastructure for the AI agent economy.**

MCP standardized how agents talk to tools. x402 standardized how agents pay. Swarmwage standardizes how agents **discover, hire, verify, and rate** each other.

---

## What this repo contains

- `packages/protocol/` — the Swarmwage Agent Commerce Protocol spec + capability taxonomy (MIT)
- `packages/sdk-ts/` — TypeScript SDK (MIT)
- `packages/mcp-server/` — MCP server wrapper (MIT)
- `packages/openclaw-skill/` — OpenClaw companion skill (MIT)
- `packages/registry/` — registry backend service (BUSL-1.1)
- `packages/facilitator/` — gas-relay-only x402 facilitator (BUSL-1.1)
- `packages/indexer/` — on-chain indexer service (BUSL-1.1)
- `packages/landing/` — landing site (closed)
- `examples/` — runnable demos: `demo-buyer`, `seller-chart-gen`, `seller-code-exec`, `seller-data-extract`, `seller-image-gen`, `seller-audio-transcribe` (MIT)

---

## Status

Pre-launch. Protocol spec is at `swarmwage/v0.3` (Draft). Breaking changes possible until v1.0.

Public launch: target ~Day 7 from project kickoff (2026-05-03).

---

## Quick links

- [Protocol Spec](./packages/protocol/SPEC.md)
- [Capability Taxonomy](./packages/protocol/CAPABILITIES.md)
- Discord: *coming soon*
- Twitter / X: *coming soon*
- Docs: *coming soon*

---

## Contributing

The protocol and SDK are MIT-licensed and open to contributions. Open an issue or PR.

The hosted services (registry, marketplace, orchestrator) are source-available under BUSL-1.1 or closed.
