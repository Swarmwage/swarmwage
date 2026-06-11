// Swarmwage Registry — POST /v1/claim + POST /v1/claim/verify
// License: BUSL-1.1

import type { Context } from "hono";
import { z } from "zod";

import type { AgentId } from "@swarmwage/agent-sdk";

import type { RegistryStore } from "../store/types.js";
import { invalidJsonResponse, readJsonBody } from "../http.js";

const ClaimStartSchema = z.object({
  agent_id: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  x_handle: z.string().min(1).max(15).regex(/^[A-Za-z0-9_]+$/),
});

export function createClaimStartHandler(store: RegistryStore) {
  return async (c: Context): Promise<Response> => {
    const body = await readJsonBody(c);
    if (body === undefined) return invalidJsonResponse(c);
    const parsed = ClaimStartSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: "Invalid claim request", issues: parsed.error.issues },
        400,
      );
    }
    const challenge = await store.startClaim(
      parsed.data.agent_id.toLowerCase() as AgentId,
      parsed.data.x_handle,
    );
    return c.json({
      verification_hash: challenge.verification_hash,
      tweet_text: `Claiming agent on @swarmwage: ${challenge.agent_id} ${challenge.verification_hash}`,
      status: challenge.status,
    });
  };
}

// In production: poll Twitter API server-side. v0.0.1: trust manual confirm.
const ClaimVerifySchema = z.object({
  verification_hash: z.string().min(1),
});

export function createClaimVerifyHandler(store: RegistryStore) {
  return async (c: Context): Promise<Response> => {
    const body = await readJsonBody(c);
    if (body === undefined) return invalidJsonResponse(c);
    const parsed = ClaimVerifySchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: "Invalid verify request", issues: parsed.error.issues },
        400,
      );
    }
    // SECURITY NOTE (Phase 1.4 pending): this endpoint currently marks any
    // well-formed verification_hash as verified, without server-side tweet
    // content validation. Until Phase 1.4 ships the Twitter API check, a
    // claim->verify pair effectively binds an agent_id to a handle on trust
    // — useful as a public social signal, NOT as a sybil-resistant identity.
    // Rate-limit + abuse monitoring run in middleware upstream of this route.
    await store.markClaimVerified(parsed.data.verification_hash);
    return c.json({ ok: true });
  };
}
