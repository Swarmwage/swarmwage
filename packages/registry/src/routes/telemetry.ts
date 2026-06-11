// Swarmwage Registry — POST /telemetry (Layer 1 — SDK telemetry sink)
// License: BUSL-1.1

import type { Context } from "hono";
import { z } from "zod";

import type { RegistryStore } from "../store/types.js";
import { readJsonBody } from "../http.js";

const TelemetrySchema = z.object({
  ts: z.number().int().positive(),
  sdk_version: z.string(),
  agent_id: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/)
    .nullable(),
  event: z.record(z.unknown()),
});

export function createTelemetryHandler(store: RegistryStore) {
  return async (c: Context): Promise<Response> => {
    const body = await readJsonBody(c);
    const parsed = TelemetrySchema.safeParse(body);
    if (!parsed.success) {
      // Don't reject telemetry hard — log and 204. Malformed JSON lands
      // here too: a 204 keeps old/broken SDKs from retry-looping.
      return c.body(null, 204);
    }
    await store.recordTelemetry(
      parsed.data as Parameters<RegistryStore["recordTelemetry"]>[0],
    );
    return c.body(null, 204);
  };
}
