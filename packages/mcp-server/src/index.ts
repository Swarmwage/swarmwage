// Swarmwage MCP Server
// Exposes the Swarmwage agent marketplace as tools for any MCP-compatible AI agent.
// License: MIT
//
// Usage:
//   SWARMWAGE_PRIVATE_KEY=0x... npx @swarmwage/mcp
//
// Or in claude_desktop_config.json / Cursor / Cline:
//   {
//     "mcpServers": {
//       "swarmwage": {
//         "command": "npx",
//         "args": ["-y", "@swarmwage/mcp"],
//         "env": { "SWARMWAGE_PRIVATE_KEY": "0x..." }
//       }
//     }
//   }

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import {
  AgentClient,
  type AgentId,
  type BudgetToken,
  type Hex,
  type Listing,
  type Stars,
} from "@swarmwage/agent-sdk";

// -------------------------------------------------------------------------
// Bootstrap
// -------------------------------------------------------------------------

const PRIVATE_KEY = process.env.SWARMWAGE_PRIVATE_KEY as Hex | undefined;
if (!PRIVATE_KEY) {
  process.stderr.write(
    "swarmwage-mcp: SWARMWAGE_PRIVATE_KEY env var is required (0x-prefixed 32-byte hex)\n",
  );
  process.exit(1);
}

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

const client = new AgentClient({
  privateKey: PRIVATE_KEY,
  registryUrl: process.env.SWARMWAGE_REGISTRY_URL,
  budget,
});

// -------------------------------------------------------------------------
// Tool definitions
// -------------------------------------------------------------------------

const tools: Tool[] = [
  {
    name: "search_agents",
    description:
      "Search the Swarmwage registry for agents that can perform a given capability. Returns a ranked list with prices, latency, and reputation. Use this when you need to find an agent for hire — e.g. when you encounter a task you cannot perform natively (image generation, audio transcription, specialized data lookup, niche translations, etc.).",
    inputSchema: {
      type: "object",
      properties: {
        capability: {
          type: "string",
          description:
            "The capability ID, e.g. 'image.generate.photorealistic.png', 'audio.transcribe.it.json-with-timestamps', 'text.translate.en.it.business'. See https://github.com/Swarmwage/swarmwage/blob/main/packages/protocol/CAPABILITIES.md for the full taxonomy.",
        },
        max_price_usdc: {
          type: "string",
          description:
            "Maximum price willing to pay per call, in USDC as a decimal string, e.g. '1.50'. Optional.",
        },
        max_latency_ms: {
          type: "number",
          description:
            "Maximum acceptable latency in milliseconds. Optional. Use 5000-15000 for sync calls.",
        },
        min_success_rate: {
          type: "number",
          description:
            "Minimum success rate (0.0-1.0). Defaults to 0.95 if you care about reliability.",
        },
        min_avg_stars: {
          type: "number",
          description: "Minimum average rating (1-5). Defaults to 4.0.",
        },
        limit: {
          type: "number",
          description: "Max results to return. Default 10.",
        },
      },
      required: ["capability"],
    },
  },
  {
    name: "hire_agent",
    description:
      "Hire an agent to execute a capability. Returns the result synchronously. Payment is in USDC via x402 with escrow + automatic verification — you only pay if the output passes the capability's verification function. Use this after you've found a suitable agent via search_agents (or pass agent_id=null to auto-pick the best match).",
    inputSchema: {
      type: "object",
      properties: {
        capability: {
          type: "string",
          description: "The capability ID to hire for, e.g. 'image.generate.photorealistic.png'.",
        },
        params: {
          type: "object",
          description:
            "Capability-specific input parameters. Schema depends on the capability. Example for image.generate.photorealistic.png: { prompt: string, width: int, height: int, seed?: int }.",
          additionalProperties: true,
        },
        max_price_usdc: {
          type: "string",
          description: "Maximum price willing to pay, in USDC decimal string, e.g. '1.00'.",
        },
        agent_id: {
          type: "string",
          description:
            "Specific agent to hire (0x-prefixed address). If omitted, the SDK picks the best match by price + reputation.",
        },
        max_latency_ms: {
          type: "number",
          description: "Maximum acceptable latency in ms. Optional.",
        },
      },
      required: ["capability", "params", "max_price_usdc"],
    },
  },
  {
    name: "check_reputation",
    description:
      "Look up reputation stats for a specific agent: success rate, average latency, hire count, ratings. Use this to vet an agent before a high-stakes hire.",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: {
          type: "string",
          description: "0x-prefixed agent address.",
        },
      },
      required: ["agent_id"],
    },
  },
  {
    name: "rate_agent",
    description:
      "Submit a rating after a hire. Use the rating_token returned in the hire receipt. Single-use per receipt. Provide honest stars (1-5) — your ratings power the reputation system that benefits everyone.",
    inputSchema: {
      type: "object",
      properties: {
        rating_token: {
          type: "string",
          description: "The rating_token from a previous hire response.",
        },
        stars: {
          type: "number",
          description: "Rating 1-5 (integer).",
          minimum: 1,
          maximum: 5,
        },
        comment: {
          type: "string",
          description: "Optional short comment.",
        },
      },
      required: ["rating_token", "stars"],
    },
  },
  {
    name: "get_remaining_budget",
    description:
      "Return how much USDC remains in the operator-authorized budget for this session. Returns '0.00' if no budget is loaded.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "get_agent_id",
    description:
      "Return the agent ID (0x-prefixed wallet address) of this MCP server. Useful for self-identification or when the operator needs to authorize budgets.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  // -----------------------------------------------------------------------
  // Seller-side tools — for agents that want to publish their own services
  // to the Swarmwage registry and earn USDC for each call.
  // -----------------------------------------------------------------------
  {
    name: "publish_listing",
    description:
      "Publish (or update) a listing on the Swarmwage registry, advertising a capability this agent can fulfill. After publishing, buyers can discover and hire you via `search_agents` and `hire_agent`. The listing is idempotent on (agent_id, capability) — calling again replaces price, endpoint, latency, etc. Your agent must already be running an HTTP server that accepts x402 payments at `endpoint`. Returns the signed listing.",
    inputSchema: {
      type: "object",
      properties: {
        capability: {
          type: "string",
          description:
            "Capability ID this listing serves, e.g. 'image.generate.photorealistic.png'. See https://github.com/Swarmwage/swarmwage/blob/main/packages/protocol/CAPABILITIES.md.",
        },
        price_usdc: {
          type: "string",
          description: "Price per call in USDC as a decimal string, e.g. '0.02'.",
        },
        endpoint: {
          type: "string",
          description:
            "Public HTTPS URL of your seller server's hire endpoint, e.g. 'https://my-agent.example.com/hire'. Must serve x402 payment-required responses and return the capability output on payment.",
        },
        max_latency_ms: {
          type: "number",
          description:
            "Worst-case latency you commit to, in milliseconds. Buyers filter by this.",
        },
        first_call_free: {
          type: "boolean",
          description:
            "Whether the first call from any new buyer is free (helps discovery). Defaults to false.",
        },
        currency: {
          type: "string",
          description: "Always 'USDC' at launch.",
          enum: ["USDC"],
        },
        chain: {
          type: "string",
          description: "Payment chain. 'base' for mainnet, 'base-sepolia' for testnet.",
          enum: ["base", "base-sepolia"],
        },
      },
      required: [
        "capability",
        "price_usdc",
        "endpoint",
        "max_latency_ms",
      ],
    },
  },
  {
    name: "update_listing",
    description:
      "Alias of `publish_listing` — same idempotent upsert. Use this when changing price, endpoint, or max_latency_ms of a capability you already publish. All fields are required (the update replaces the entire listing).",
    inputSchema: {
      type: "object",
      properties: {
        capability: {
          type: "string",
          description: "Capability ID being updated.",
        },
        price_usdc: { type: "string", description: "New price per call in USDC." },
        endpoint: { type: "string", description: "New endpoint URL." },
        max_latency_ms: { type: "number", description: "New max latency in ms." },
        first_call_free: { type: "boolean" },
        currency: { type: "string", enum: ["USDC"] },
        chain: { type: "string", enum: ["base", "base-sepolia"] },
      },
      required: [
        "capability",
        "price_usdc",
        "endpoint",
        "max_latency_ms",
      ],
    },
  },
  {
    name: "list_my_listings",
    description:
      "Return all active listings this agent has published to the registry. Read-only. Use this to see what capabilities you're currently offering and at what price.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "get_my_receipts",
    description:
      "Return recent receipts this agent has submitted to the registry (seller-side view). Receipts are written automatically by the SDK's x402 post-settle hook after each successful hire — this tool is read-only visibility, NOT a way to submit them manually. Use it to audit your recent earnings, dispute rate, or verification pass rate. Most recent first.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          description: "How many receipts to return. Default 50, max 200.",
        },
      },
    },
  },
];

// -------------------------------------------------------------------------
// Server
// -------------------------------------------------------------------------

const server = new Server(
  { name: "swarmwage", version: "0.0.1" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: rawArgs } = request.params;
  const args = (rawArgs ?? {}) as Record<string, unknown>;

  try {
    switch (name) {
      case "search_agents": {
        const results = await client.search({
          capability: String(args.capability),
          max_price_usdc: args.max_price_usdc as string | undefined,
          max_latency_ms: args.max_latency_ms as number | undefined,
          min_success_rate: args.min_success_rate as number | undefined,
          min_avg_stars: args.min_avg_stars as number | undefined,
          limit: args.limit as number | undefined,
        });
        return ok({ agents: results });
      }

      case "hire_agent": {
        const response = await client.hire({
          capability: String(args.capability),
          params: (args.params ?? {}) as Record<string, unknown>,
          max_price_usdc: String(args.max_price_usdc),
          agent_id: args.agent_id as AgentId | undefined,
          max_latency_ms: args.max_latency_ms as number | undefined,
        });
        return ok({
          result: response.result,
          receipt: response.receipt,
          verification: response.verification,
          rating_token: response.rating_token,
          remaining_budget_usdc: client.remainingBudget(),
        });
      }

      case "check_reputation": {
        const rep = await client.getReputation(args.agent_id as AgentId);
        return ok(rep);
      }

      case "rate_agent": {
        await client.rate(String(args.rating_token), {
          stars: Number(args.stars) as Stars,
          comment: args.comment as string | undefined,
        });
        return ok({ success: true });
      }

      case "get_remaining_budget": {
        return ok({ remaining_usdc: client.remainingBudget() });
      }

      case "get_agent_id": {
        return ok({ agent_id: client.agentId });
      }

      case "publish_listing":
      case "update_listing": {
        const listing = await client.publishListing({
          capability: String(args.capability),
          price_usdc: String(args.price_usdc),
          endpoint: String(args.endpoint),
          max_latency_ms: Number(args.max_latency_ms),
          first_call_free: Boolean(args.first_call_free ?? false),
          currency: (args.currency as "USDC" | undefined) ?? "USDC",
          chain: (args.chain as Listing["chain"] | undefined) ?? "base",
        } as Omit<Listing, "agent_id" | "signature">);
        return ok({ listing });
      }

      case "list_my_listings": {
        const listings = await client.getMyListings();
        return ok({ count: listings.length, listings });
      }

      case "get_my_receipts": {
        const receipts = await client.getMyReceipts({
          limit: args.limit as number | undefined,
        });
        return ok({ count: receipts.length, receipts });
      }

      default:
        return err(`Unknown tool: ${name}`);
    }
  } catch (e) {
    const error = e as Error & { code?: string };
    return err(
      `${error.code ? `[${error.code}] ` : ""}${error.message ?? "Unknown error"}`,
    );
  }
});

function ok(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  };
}

function err(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true,
  };
}

// -------------------------------------------------------------------------
// Run
// -------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);

process.stderr.write(
  `swarmwage-mcp v0.0.1 ready (agent_id=${client.agentId})\n`,
);
