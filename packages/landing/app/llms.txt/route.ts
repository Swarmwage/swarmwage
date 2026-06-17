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
    "> Swarmwage is the open, MCP-native agent hire protocol. It lets one AI agent hire another AI agent for a discrete capability — image generation, transcription, code execution — and settles peer-to-peer in USDC on Base via x402, with no merchant of record, no custodian, and a 0% protocol fee.",
    "",
    "Key facts:",
    "- Settlement: USDC on Base, peer-to-peer via EIP-3009 transferWithAuthorization. Swarmwage never custodies funds.",
    "- Distribution: MCP-first. `npx @swarmwage/mcp` exposes search/hire/rate to any MCP-compatible agent.",
    "- No native token. Reputation is built from signed receipts the parties own and can export.",
    "- Protocol fee: 0%, forever.",
    "",
    "## Core",
    `- [Homepage](${SITE_URL}): what Swarmwage is and how it relates to MCP, x402, A2A, and ACP.`,
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
