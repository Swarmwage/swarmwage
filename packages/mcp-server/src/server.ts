// Swarmwage MCP — server (stdio MCP transport)
// License: MIT

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  AgentClient,
  type AgentId,
  type BudgetToken,
  type ExternalX402ReliabilityQuery,
  type ExternalX402ReliabilityResponse,
  type Hex,
  type Reputation,
  type SearchRequest,
  type SearchResponse,
} from "@swarmwage/agent-sdk";

import {
  searchAgenticMarketServices,
  type AgenticMarketSearchRequest,
  type AgenticMarketSearchResponse,
} from "./agentic-market.js";
import { loadWallet } from "./config.js";
import { VERSION } from "./constants.js";
import { createToolHandler } from "./handlers.js";
import { tools } from "./tools.js";
import { checkForUpdate } from "./update-check.js";

export async function runServer(): Promise<void> {
  // Pure-config inputs we can read sync. Anything that does I/O (file read,
  // network) is deferred so the transport handshake is not blocked.
  const REGISTRY_URL =
    process.env.SWARMWAGE_REGISTRY_URL ?? "https://api.swarmwage.com";
  const NETWORK: "base" | "base-sepolia" =
    (process.env.SWARMWAGE_NETWORK as "base" | "base-sepolia" | undefined) ??
    "base";
  const envKey = process.env.SWARMWAGE_PRIVATE_KEY as Hex | undefined;

  let budget: BudgetToken | undefined;
  if (process.env.SWARMWAGE_BUDGET_TOKEN) {
    try {
      budget = JSON.parse(process.env.SWARMWAGE_BUDGET_TOKEN) as BudgetToken;
    } catch (err) {
      process.stderr.write(
        `swarmwage-mcp: SWARMWAGE_BUDGET_TOKEN is not valid JSON: ${(err as Error).message}\n`,
      );
      process.exit(1);
    }
  }

  // Direct fetch so we can surface registry metadata (`available_capabilities`
  // and `total_distinct_capabilities`) on empty results — the SDK's
  // `client.search()` strips those fields. Calling LLMs use the hint to
  // recover from a wrong capability guess on the same turn instead of
  // hallucinating a different ID.
  async function directSearch(req: SearchRequest): Promise<SearchResponse> {
    const res = await fetch(`${REGISTRY_URL}/v1/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req),
    });
    if (!res.ok) {
      throw new Error(
        `registry search failed: ${res.status} ${res.statusText}`,
      );
    }
    return (await res.json()) as SearchResponse;
  }

  async function directReputation(agentId: AgentId): Promise<Reputation> {
    const res = await fetch(
      `${REGISTRY_URL}/v1/agents/${agentId}/reputation`,
    );
    if (!res.ok) {
      throw new Error(
        `registry reputation failed: ${res.status} ${res.statusText}`,
      );
    }
    return (await res.json()) as Reputation;
  }

  async function searchExternalX402Services(
    req: AgenticMarketSearchRequest,
  ): Promise<AgenticMarketSearchResponse> {
    return searchAgenticMarketServices(req);
  }

  async function directExternalX402Reliability(
    req: ExternalX402ReliabilityQuery,
  ): Promise<ExternalX402ReliabilityResponse> {
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
    return (await res.json()) as ExternalX402ReliabilityResponse;
  }

  // Lazy wallet + client load — kicked off in the background AFTER the
  // transport handshake so `tools/list` is never blocked by file I/O or viem
  // wallet client init. Calling LLMs see the tool catalog immediately;
  // wallet-only tools (hire_agent, publish_listing, etc.) await this promise
  // at call time and the first call waits ~50-200ms once. Read-only tools
  // (search_agents, search_x402_services, get_x402_service_reliability,
  // check_reputation, list_capabilities, get_agent_id with null fallback,
  // get_remaining_budget with '0.00' fallback) never wait.
  //
  // This eliminates the race condition where slow MCP-host harnesses close
  // their deferred-tool index before our pre-connect setup completes.
  let clientPromise: Promise<AgentClient | undefined> | null = null;
  function ensureClient(): Promise<AgentClient | undefined> {
    if (!clientPromise) {
      clientPromise = (async () => {
        const fileKey = envKey ? null : await loadWallet();
        const PRIVATE_KEY: Hex | undefined = envKey ?? fileKey ?? undefined;
        if (!PRIVATE_KEY) return undefined;
        return new AgentClient({
          privateKey: PRIVATE_KEY,
          registryUrl: REGISTRY_URL,
          budget,
          network: NETWORK,
        });
      })();
    }
    return clientPromise;
  }

  const server = new Server(
    { name: "swarmwage", version: VERSION },
    // `tools.listChanged: true` signals that the tool list is dynamic and
    // the host should re-read on `notifications/tools/list_changed`. We
    // never actually mutate the list at runtime today, but advertising the
    // capability makes harnesses with stricter cache-invalidation behavior
    // re-query on retry instead of pinning a stale empty list.
    { capabilities: { tools: { listChanged: true } } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

  const handleToolCall = createToolHandler({
    ensureClient,
    directSearch,
    directReputation,
    searchExternalX402Services,
    directExternalX402Reliability,
  });
  server.setRequestHandler(CallToolRequestSchema, async (request) =>
    handleToolCall(request.params),
  );

  // Connect the transport IMMEDIATELY — before any file I/O or wallet init.
  // `tools/list` is now answerable from the moment the host sends it. This
  // fixes the race where slow MCP hosts close their deferred-tool index
  // before the pre-connect setup finished (observed in Claude Code on
  // cold-start of a session that had `npx -y @swarmwage/mcp` registered).
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`swarmwage-mcp v${VERSION} listening on stdio\n`);

  // Now kick off wallet preload in the background. Tool calls that need a
  // wallet will await this same promise; calls that don't (search, list,
  // reputation) never touch it.
  void ensureClient().then((client) => {
    if (client) {
      const source = envKey ? "env" : "config";
      process.stderr.write(
        `swarmwage-mcp v${VERSION} wallet ready (agent_id=${client.agentId}, source=${source})\n`,
      );
    } else {
      process.stderr.write(
        `swarmwage-mcp v${VERSION} lookup-only (no wallet)\n` +
          `  Enabled: search_agents, search_x402_services, get_x402_service_reliability, list_capabilities, check_reputation, get_remaining_budget, get_agent_id\n` +
          `  Setup wallet: npx @swarmwage/mcp\n`,
      );
    }
  });

  // Fire-and-forget update probe. The MCP loop above is already serving
  // requests; this writes one stderr line if an update is available, then
  // exits silently on any error or network slowness.
  void checkForUpdate();
}
