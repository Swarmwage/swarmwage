// Swarmwage Registry — POST /v1/rate (disabled until Phase 1.4)
// License: BUSL-1.1

import type { Context } from "hono";
import { z } from "zod";

// Comment angle-bracket guard: stops HTML/<script> tags from being
// persisted into the future leaderboard render. Activates only when
// Phase 1.4 re-enables the endpoint; today /v1/rate short-circuits
// with HTTP 503 (see below).
const RateSchema = z.object({
  rating_token: z.string().min(1),
  stars: z.number().int().min(1).max(5),
  latency_ms: z.number().int().positive().optional(),
  comment: z
    .string()
    .max(1024)
    .regex(/^[^<>]*$/, "comment must not contain '<' or '>'")
    .optional(),
});
void RateSchema; // keep ts-pruned alive — referenced when /v1/rate re-enables

// Rating endpoint disabled until Phase 1.4 ships the rating_token
// decoder. Today the handler stored placeholder zero-address
// rater_id/rated_id for every consumed token, so the API was lying
// (`success: true` on any string) AND silently burning token slots
// that real receipts will later need. Returning 503 with a structured
// error stops the dishonest acknowledgement without breaking the
// route surface for clients that already wire it up.
export function createRateHandler() {
  return (c: Context): Response =>
    c.json(
      {
        ok: false,
        error:
          "Rating system not yet enabled — pending Phase 1.4 rating_token decoder",
        retry: false,
      },
      503,
    );
}
