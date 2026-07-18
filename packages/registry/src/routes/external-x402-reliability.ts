// Swarmwage Registry — external x402 reliability records
// License: BUSL-1.1
//
// Buyer/client-observed records for third-party x402 services. These are not
// seller-signed Swarmwage receipts; they are observed reliability evidence.

import type { Context } from "hono";
import { z } from "zod";

import type { RegistryStore } from "../store/types.js";
import { invalidJsonResponse, readJsonBody } from "../http.js";

const Hex32Schema = z.string().regex(/^0x[a-fA-F0-9]{64}$/);
const AgentIdSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/);

const ExternalX402ReliabilityRecordSchema = z.object({
  ts: z.number().int().positive().optional(),
  trust_level: z.literal("client_observed").default("client_observed"),
  buyer_agent_id: AgentIdSchema.nullable().default(null),
  source: z.string().min(1).max(200).optional(),
  service_id: z.string().min(1).max(300).optional(),
  service_name: z.string().min(1).max(300).optional(),
  category: z.string().min(1).max(200).optional(),
  endpoint_description: z.string().min(1).max(1000).optional(),
  pricing_scheme: z.string().min(1).max(100).optional(),
  url: z.string().url(),
  method: z.string().min(1).max(16).transform((v) => v.toUpperCase()),
  status: z.number().int().min(0).max(599),
  amount_paid_usdc: z.string().regex(/^\d+(\.\d+)?$/).optional(),
  tx_hash: Hex32Schema.optional(),
  latency_ms: z.number().int().min(0),
  request_hash: Hex32Schema.optional(),
  response_hash: Hex32Schema,
  verifier_kind: z.enum(["none", "json", "custom"]).default("none"),
  verifier_status: z.enum(["unknown", "pass", "fail"]).default("unknown"),
  verifier_checks: z.record(z.boolean()).default({}),
  error: z.string().max(1000).optional(),
});

export function createSubmitExternalX402ReliabilityHandler(store: RegistryStore) {
  return async (c: Context): Promise<Response> => {
    const body = await readJsonBody(c);
    if (body === undefined) return invalidJsonResponse(c);
    const parsed = ExternalX402ReliabilityRecordSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        {
          ok: false,
          error: "Invalid external x402 reliability record",
          issues: parsed.error.issues,
        },
        400,
      );
    }
    const result = await store.appendExternalX402ReliabilityRecord({
      ...parsed.data,
      ts: parsed.data.ts ?? Date.now(),
      trust_level: "client_observed",
      buyer_agent_id: parsed.data.buyer_agent_id as `0x${string}` | null,
      tx_hash: parsed.data.tx_hash as `0x${string}` | undefined,
      request_hash: parsed.data.request_hash as `0x${string}` | undefined,
      response_hash: parsed.data.response_hash as `0x${string}`,
    });
    return c.json({
      ok: true,
      reliability_record_id: result.id,
      trust_level: "client_observed",
    });
  };
}

export function createListExternalX402ReliabilityHandler(store: RegistryStore) {
  return async (c: Context): Promise<Response> => {
    const limitRaw = c.req.query("limit");
    const parsedLimit = limitRaw ? Number(limitRaw) : undefined;
    if (
      parsedLimit !== undefined &&
      (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 200)
    ) {
      return c.json({ error: "Invalid limit" }, 400);
    }
    const url = c.req.query("url") || undefined;
    if (url && !z.string().url().safeParse(url).success) {
      return c.json({ error: "Invalid url" }, 400);
    }
    const services = await store.listExternalX402ServiceReliability({
      limit: parsedLimit,
      source: c.req.query("source") || undefined,
      service_id: c.req.query("service_id") || undefined,
      url,
    });
    return c.json({
      trust_level: "client_observed",
      count: services.length,
      services,
      note:
        "External x402 services are third-party endpoints, not Swarmwage sellers. These aggregates are client-observed reliability evidence, not seller-signed receipts or guarantees.",
    });
  };
}
