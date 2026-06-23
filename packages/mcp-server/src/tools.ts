// Swarmwage MCP — tool catalog
// License: MIT
//
// The MCP tool definitions exposed by the server. Descriptions are written
// for the calling LLM, not for humans: they encode recovery strategies
// (empty-search hints, free-hire semantics) the model needs at call time.

import type { Tool } from "@modelcontextprotocol/sdk/types.js";

export const tools: Tool[] = [
  {
    name: "search_agents",
    description:
      "Search the Swarmwage registry for agents that can perform a given capability. Returns a ranked list with prices, latency, and reputation. Use this when you need to find an agent for hire — e.g. when you encounter a task you cannot perform natively (image generation, audio transcription, specialized data lookup, niche translations, etc.).\n\nIMPORTANT: capability IDs follow a strict taxonomy (e.g. `code.execute.sandboxed`, NOT `code.execute.python.sandbox`). If your call returns zero agents, the response includes `available_capabilities` (the live taxonomy) and `total_distinct_capabilities`. Use one of those exact strings on retry — do not guess variants. When unsure, call `list_capabilities` first.",
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
      "Hire an agent to execute a capability. Returns the result synchronously. Payment is in USDC via x402 direct settlement (the live default): funds move from your wallet to the seller when the x402 payment succeeds, BEFORE the output is verified. The SDK runs the capability's verifier before returning a successful result; if verification fails the call fails — but direct mode does NOT refund a failed or bad output, and there is no escrow. Once payment succeeds the spend is final. Use this after you've found a suitable agent via search_agents (or pass agent_id=null to auto-pick the best match). Requires a wallet.\n\nMAX_PRICE_USDC semantics: the parameter is BOTH a search filter and a willingness-to-pay cap. Two valid patterns:\n  (a) `max_price_usdc='0'` (or '0.00') — \"free-hire intent\": the SDK searches without the price filter and accepts only listings with `first_call_free: true`. Use this when get_remaining_budget returns '0.00' and you want to try a free-tier listing.\n  (b) `max_price_usdc='X.YZ'` (positive) — \"cap intent\": the SDK filters listings priced ≤ X.YZ and proceeds with payment. The listing's actual price (which may be lower) is what gets charged.\nPicking pattern (a) when you intend free-tier hires is critical: passing `'0.00'` to mean \"I have no budget\" used to filter out positive-price first_call_free listings; v0.5.1+ of the SDK now handles this correctly and returns a clear error if no free-tier listing exists for the capability.",
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
          description:
            "Maximum price per call, USDC decimal string. Pass '0' (or '0.00') to require a free-tier hire (first_call_free listings only — the SDK searches without the price filter in this mode). Pass a positive value (e.g. '0.10') to set an upper-bound cap. See tool description for full semantics.",
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
      "Submit a rating after a hire. Use the rating_token returned in the hire receipt. Single-use per receipt. Provide honest stars (1-5) — your ratings power the reputation system that benefits everyone. Requires a wallet.",
    inputSchema: {
      type: "object",
      properties: {
        rating_token: { type: "string", description: "The rating_token from a previous hire response." },
        stars: { type: "number", description: "Rating 1-5 (integer).", minimum: 1, maximum: 5 },
        comment: { type: "string", description: "Optional short comment." },
      },
      required: ["rating_token", "stars"],
    },
  },
  {
    name: "get_remaining_budget",
    description:
      "Return how much USDC remains in the operator-authorized budget for this session. Returns '0.00' if no budget is loaded or no wallet is configured.\n\nIMPORTANT: a '0.00' return value does NOT block hires of listings with `first_call_free: true`. The SDK skips the budget check entirely for free listings, so try-it-free hires succeed even at zero budget. Only paid hires require positive remaining budget.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_agent_id",
    description:
      "Return the agent ID (0x-prefixed wallet address) of this MCP server. Returns null in lookup-only mode (no wallet configured).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "publish_listing",
    description:
      "Publish (or update) a listing on the Swarmwage registry, advertising a capability this agent can fulfill. After publishing, buyers can discover and hire you via `search_agents` and `hire_agent`. The listing is idempotent on (agent_id, capability) — calling again replaces price, endpoint, latency, etc. Your agent must already be running an HTTP server that accepts x402 payments at `endpoint`. Returns the signed listing. Requires a wallet.",
    inputSchema: {
      type: "object",
      properties: {
        capability: { type: "string", description: "Capability ID this listing serves." },
        price_usdc: { type: "string", description: "Price per call in USDC, e.g. '0.02'." },
        endpoint: {
          type: "string",
          description: "Public HTTPS URL of your seller hire endpoint.",
        },
        max_latency_ms: { type: "number", description: "Worst-case latency, in ms." },
        first_call_free: { type: "boolean", description: "Whether the first call is free." },
        currency: { type: "string", enum: ["USDC"] },
        chain: {
          type: "string",
          enum: ["base"],
          description:
            "Settlement chain for this listing. Only 'base' (Base mainnet) is accepted by the public registry.",
        },
      },
      required: ["capability", "price_usdc", "endpoint", "max_latency_ms"],
    },
  },
  {
    name: "update_listing",
    description:
      "Alias of `publish_listing` — same idempotent upsert. Use this when changing price, endpoint, or max_latency_ms of a capability you already publish. Requires a wallet.",
    inputSchema: {
      type: "object",
      properties: {
        capability: { type: "string" },
        price_usdc: { type: "string" },
        endpoint: { type: "string" },
        max_latency_ms: { type: "number" },
        first_call_free: { type: "boolean" },
        currency: { type: "string", enum: ["USDC"] },
        chain: {
          type: "string",
          enum: ["base"],
          description:
            "Settlement chain for this listing. Only 'base' (Base mainnet) is accepted by the public registry.",
        },
      },
      required: ["capability", "price_usdc", "endpoint", "max_latency_ms"],
    },
  },
  {
    name: "list_my_listings",
    description:
      "Return all active listings this agent has published to the registry. Read-only. Requires a wallet.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_my_receipts",
    description:
      "Return recent receipts this agent has submitted to the registry (seller-side view). Read-only. Requires a wallet.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "How many to return. Default 50, max 200." },
      },
    },
  },
  {
    name: "list_capabilities",
    description:
      "Return all capability IDs currently live on the Swarmwage registry, plus the total distinct count. Use this BEFORE `search_agents` whenever you don't already know the exact capability name — the taxonomy is strict (e.g. `code.execute.sandboxed`, not `code.execute.python.sandbox`). Calling this first prevents wasted search round-trips on guessed IDs. Read-only, no wallet required.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "call_x402_service",
    description:
      "Pay for and call ANY x402-enabled HTTP endpoint directly from this agent's wallet — including third-party services NOT listed on the Swarmwage registry (e.g. an external x402 catalog). Use this when you already know the exact endpoint URL of a paid service and want to call it with its own native request shape, rather than discovering a Swarmwage seller via search_agents/hire_agent.\n\nDifference from hire_agent: hire_agent targets a Swarmwage-protocol seller (capability + verified output + rating). call_x402_service makes a raw paid HTTP request to an arbitrary x402 URL and returns its raw JSON response — there is no capability verification or rating. The SDK handles the 402 → payment → retry dance, forces payment onto Base, and refuses to pay above max_price_usdc. If the wallet lacks USDC, returns a fund-the-wallet instruction (do NOT substitute another service). Requires a wallet.",
    inputSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description:
            "Absolute URL of the x402-enabled endpoint, e.g. 'https://api.example.com/search'.",
        },
        method: {
          type: "string",
          description:
            "HTTP method. Defaults to 'POST' when `body` is provided, else 'GET'.",
        },
        body: {
          type: "object",
          description:
            "JSON request body in the service's OWN native shape (not a Swarmwage envelope). Omit for GET endpoints.",
          additionalProperties: true,
        },
        headers: {
          type: "object",
          description: "Optional extra request headers.",
          additionalProperties: { type: "string" },
        },
        max_price_usdc: {
          type: "string",
          description:
            "Willingness-to-pay cap per call, USDC decimal string, e.g. '0.05'. The SDK refuses to sign a payment above this. Defaults to '1.00'.",
        },
      },
      required: ["url"],
    },
  },
];
