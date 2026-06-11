// Swarmwage Registry — POST /v1/search
// License: BUSL-1.1

import type { Context } from "hono";
import { z } from "zod";

import type { RegistryStore } from "../store/types.js";
import { invalidJsonResponse, readJsonBody } from "../http.js";

const SearchSchema = z.object({
  capability: z.string().min(1),
  // `match` controls how the capability string is interpreted.
  // - "exact"  (default): listings.capability === req.capability.
  // - "prefix": listings.capability startsWith req.capability. Useful for
  //   marketed shorthand like `audio.transcribe` (matches the canonical
  //   `audio.transcribe.json-with-timestamps`).
  // Default kept as "exact" for backwards compatibility with existing
  // SDK / MCP / facilitator callers.
  match: z.enum(["exact", "prefix"]).optional().default("exact"),
  max_price_usdc: z.string().optional(),
  max_latency_ms: z.number().int().positive().optional(),
  min_success_rate: z.number().min(0).max(1).optional(),
  min_avg_stars: z.number().min(0).max(5).optional(),
  limit: z.number().int().min(1).max(100).optional(),
  cursor: z.string().optional(),
});

export function createSearchHandler(store: RegistryStore) {
  return async (c: Context): Promise<Response> => {
    const body = await readJsonBody(c);
    if (body === undefined) return invalidJsonResponse(c);
    const parsed = SearchSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: "Invalid search request", issues: parsed.error.issues },
        400,
      );
    }
    const { match, ...searchReq } = parsed.data;
    const agents =
      match === "prefix"
        ? await store.searchByCapabilityPrefix(searchReq)
        : await store.search(searchReq);
    if (agents.length === 0) {
      const [available_capabilities, total_distinct_capabilities] =
        await Promise.all([
          store.listActiveCapabilities(20),
          store.countCapabilities(),
        ]);
      return c.json({
        agents,
        next_cursor: null,
        match,
        available_capabilities,
        total_distinct_capabilities,
      });
    }
    return c.json({ agents, next_cursor: null, match });
  };
}
