// Swarmwage MCP — human-facing CLI commands
// License: MIT
//
// Thin read-only wrapper around the same discovery/reliability path exposed
// through MCP. Paid calls stay in the MCP/server flow for now; the CLI gives a
// developer a fast way to inspect the market before funding a wallet.

import type {
  AgentId,
  ExternalX402ReliabilityQuery,
  Reputation,
  SearchRequest,
  SearchResponse,
} from "@swarmwage/agent-sdk";

import { searchAgenticMarketServices } from "./agentic-market.js";
import { createToolHandler, type ToolResult } from "./handlers.js";

interface ParsedArgs {
  command: string | undefined;
  positionals: string[];
  flags: Record<string, string | boolean>;
}

const REGISTRY_URL =
  process.env.SWARMWAGE_REGISTRY_URL ?? "https://api.swarmwage.com";

function parseArgs(argv: string[]): ParsedArgs {
  const [command, ...rest] = argv;
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }

    const eq = arg.indexOf("=");
    if (eq !== -1) {
      flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }

    const key = arg.slice(2);
    const next = rest[i + 1];
    if (next && !next.startsWith("--")) {
      flags[key] = next;
      i++;
    } else {
      flags[key] = true;
    }
  }

  return { command, positionals, flags };
}

function flag(
  flags: Record<string, string | boolean>,
  name: string,
): string | undefined {
  const value = flags[name];
  return typeof value === "string" ? value : undefined;
}

function flagNumber(
  flags: Record<string, string | boolean>,
  name: string,
): number | undefined {
  const value = flag(flags, name);
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new Error(`--${name} must be a number`);
  }
  return n;
}

function printHelp(): void {
  console.log(`Swarmwage CLI

Usage:
  npx @swarmwage/mcp                         run setup wizard
  npx @swarmwage/mcp --server                run MCP server
  npx @swarmwage/mcp capabilities            list live capability IDs
  npx @swarmwage/mcp search <capability>     search Swarmwage-native sellers
  npx @swarmwage/mcp x402-search [query]     search external x402 services
  npx @swarmwage/mcp reliability [filters]   read x402 reliability evidence
  npx @swarmwage/mcp dry-run <url>           inspect a paid x402 call plan

Common options:
  --limit <n>
  --max-price <usdc>
  --url <url>
  --service-id <id>
  --source <source>
  --method <GET|POST>
  --dynamic                               include dynamic x402 prices

Examples:
  npx @swarmwage/mcp capabilities
  npx @swarmwage/mcp search code.execute.sandboxed --limit 5
  npx @swarmwage/mcp x402-search "web search" --max-price 0.02
  npx @swarmwage/mcp reliability --url https://example.com/x402
  npx @swarmwage/mcp dry-run https://example.com/x402 --max-price 0.02
`);
}

async function directSearch(req: SearchRequest): Promise<SearchResponse> {
  const res = await fetch(`${REGISTRY_URL}/v1/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
  });
  if (!res.ok) {
    throw new Error(`registry search failed: ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as SearchResponse;
}

async function directReputation(agentId: AgentId): Promise<Reputation> {
  const res = await fetch(`${REGISTRY_URL}/v1/agents/${agentId}/reputation`);
  if (!res.ok) {
    throw new Error(
      `registry reputation failed: ${res.status} ${res.statusText}`,
    );
  }
  return (await res.json()) as Reputation;
}

async function directExternalX402Reliability(
  req: ExternalX402ReliabilityQuery,
) {
  const params = new URLSearchParams();
  if (req.limit !== undefined) params.set("limit", String(req.limit));
  if (req.source) params.set("source", req.source);
  if (req.service_id) params.set("service_id", req.service_id);
  if (req.url) params.set("url", req.url);
  const qs = params.toString();
  const res = await fetch(
    `${REGISTRY_URL}/v1/reliability/external-x402${qs ? `?${qs}` : ""}`,
  );
  if (!res.ok) {
    throw new Error(
      `registry reliability lookup failed: ${res.status} ${res.statusText}`,
    );
  }
  return res.json();
}

function printToolResult(result: ToolResult): void {
  const text = result.content[0]?.text ?? "";
  if (result.isError) {
    console.error(text);
    process.exitCode = 1;
    return;
  }
  console.log(text);
}

export async function runCli(argv: string[]): Promise<void> {
  const parsed = parseArgs(argv);
  if (!parsed.command || parsed.command === "help") {
    printHelp();
    return;
  }

  const handler = createToolHandler({
    ensureClient: async () => undefined,
    directSearch,
    directReputation,
    searchExternalX402Services: searchAgenticMarketServices,
    directExternalX402Reliability,
  });

  switch (parsed.command) {
    case "capabilities":
    case "list": {
      printToolResult(await handler({ name: "list_capabilities" }));
      return;
    }

    case "search": {
      const capability = parsed.positionals[0];
      if (!capability) throw new Error("usage: search <capability>");
      printToolResult(
        await handler({
          name: "search_agents",
          arguments: {
            capability,
            limit: flagNumber(parsed.flags, "limit"),
            max_price_usdc: flag(parsed.flags, "max-price"),
          },
        }),
      );
      return;
    }

    case "x402-search": {
      printToolResult(
        await handler({
          name: "search_x402_services",
          arguments: {
            query: parsed.positionals.join(" ") || undefined,
            limit: flagNumber(parsed.flags, "limit"),
            max_price_usdc: flag(parsed.flags, "max-price"),
            category: flag(parsed.flags, "category"),
            include_dynamic_pricing: parsed.flags.dynamic === true,
          },
        }),
      );
      return;
    }

    case "reliability": {
      printToolResult(
        await handler({
          name: "get_x402_service_reliability",
          arguments: {
            source: flag(parsed.flags, "source"),
            service_id: flag(parsed.flags, "service-id"),
            url: flag(parsed.flags, "url"),
            limit: flagNumber(parsed.flags, "limit"),
          },
        }),
      );
      return;
    }

    case "dry-run": {
      const url = parsed.positionals[0] ?? flag(parsed.flags, "url");
      if (!url) throw new Error("usage: dry-run <url>");
      printToolResult(
        await handler({
          name: "call_x402_service",
          arguments: {
            url,
            method: flag(parsed.flags, "method"),
            max_price_usdc: flag(parsed.flags, "max-price"),
            source: flag(parsed.flags, "source"),
            service_id: flag(parsed.flags, "service-id"),
            dry_run: true,
          },
        }),
      );
      return;
    }

    default:
      throw new Error(`unknown command: ${parsed.command}`);
  }
}
