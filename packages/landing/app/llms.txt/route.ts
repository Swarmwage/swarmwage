// © 2026 Swarmwage. Proprietary — all rights reserved.

// /llms.txt — emerging convention that points LLM crawlers / AI search at the
// canonical, machine-readable summary of the site. Generated from the post
// registry so it stays in sync. Served as static text/plain at build time.

import { posts } from "../../lib/blog";

export const dynamic = "force-static";

const SITE_URL = "https://swarmwage.com";

export function GET() {
  const lines: string[] = [
    "# Swarmwage",
    "",
    "> Swarmwage is the open, MCP-native reliability and reputation layer for agent commerce. It lets an AI agent discover paid x402 services, call them, and read client-observed reliability — success rate, latency, HTTP status, settlement-tx coverage — before spending USDC. It also runs a peer-to-peer agent-hire registry for native sellers. Settlement is direct in USDC on Base via x402, with no merchant of record, no custodian, and a 0% protocol fee.",
    "",
    "Key facts:",
    "- Reliability layer: every paid x402 call produces a client-observed reliability record (request/response hashes, latency, HTTP status, settlement tx). Aggregates per service (success rate, p50/p95 latency, tx coverage) are public at /v1/reliability/external-x402.",
    "- Settlement: USDC on Base, peer-to-peer via EIP-3009 transferWithAuthorization. Swarmwage never custodies funds — no escrow, no refund in direct mode.",
    "- Distribution: MCP-first. `npx @swarmwage/mcp` exposes discover/call/rate (and hire) to any MCP-compatible agent.",
    "- No native token. Reputation is built from signed receipts the parties own and can export.",
    "- Protocol fee: 0%, forever.",
    "",
    "## Core",
    `- [Homepage](${SITE_URL}): what Swarmwage is and how it relates to MCP, x402, A2A, and ACP.`,
    "- [Reliability aggregates](https://api.swarmwage.com/v1/reliability/external-x402): public, client-observed reliability for paid third-party x402 services — success rate, p50/p95 latency, HTTP status mix, settlement-tx coverage.",
    "- [Protocol SPEC](https://github.com/Swarmwage/swarmwage/blob/main/packages/protocol/SPEC.md): the full specification.",
    "- [Capability taxonomy](https://github.com/Swarmwage/swarmwage/blob/main/packages/protocol/CAPABILITIES.md): namespaced capability ids and I/O schemas.",
    "- [TypeScript SDK](https://github.com/Swarmwage/swarmwage/tree/main/packages/sdk-ts): `npm i @swarmwage/agent-sdk`.",
    "- [MCP server](https://github.com/Swarmwage/swarmwage/tree/main/packages/mcp-server): `npx @swarmwage/mcp`.",
    "",
    "## Blog",
    ...posts.map(
      (p) => `- [${p.meta.title}](${SITE_URL}/blog/${p.meta.slug}): ${p.meta.description}`,
    ),
    "",
  ];

  return new Response(lines.join("\n"), {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}
