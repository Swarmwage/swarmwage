// Swarmwage Registry — GET /v1/agents/:id/{reputation,listings,receipts}
// License: BUSL-1.1

import type { Context } from "hono";

import type { AgentId } from "@swarmwage/agent-sdk";

import type { RegistryStore } from "../store/types.js";

function parseAgentId(c: Context): AgentId | null {
  const raw = c.req.param("id");
  if (!raw) return null;
  const id = raw.toLowerCase() as AgentId;
  return /^0x[a-fA-F0-9]{40}$/.test(id) ? id : null;
}

export function createReputationHandler(store: RegistryStore) {
  return async (c: Context): Promise<Response> => {
    const id = parseAgentId(c);
    if (!id) return c.json({ error: "Invalid agent_id" }, 400);
    const rep = await store.getReputation(id);
    if (!rep) return c.json({ error: "Agent not found" }, 404);
    return c.json(rep);
  };
}

// All active listings for a seller. Read-only; no signature required.
// Powers the `list_my_listings` MCP tool and any external dashboard.
export function createAgentListingsHandler(store: RegistryStore) {
  return async (c: Context): Promise<Response> => {
    const id = parseAgentId(c);
    if (!id) return c.json({ error: "Invalid agent_id" }, 400);
    const listings = await store.getListingsByAgent(id);
    return c.json({ agent_id: id, count: listings.length, listings });
  };
}

// Recent receipts submitted by a seller. Read-only; the on-chain tx_hash
// is already public, so this surface is too. Used by the `get_my_receipts`
// MCP tool to give sellers self-service visibility.
export function createAgentReceiptsHandler(store: RegistryStore) {
  return async (c: Context): Promise<Response> => {
    const id = parseAgentId(c);
    if (!id) return c.json({ error: "Invalid agent_id" }, 400);
    const limitRaw = c.req.query("limit");
    const limit = limitRaw ? Number(limitRaw) : undefined;
    if (limit !== undefined && (!Number.isFinite(limit) || limit < 1)) {
      return c.json({ error: "Invalid limit" }, 400);
    }
    const receipts = await store.getReceiptsByAgent(id, { limit });
    return c.json({ agent_id: id, count: receipts.length, receipts });
  };
}
