// Endpoint ownership challenge (Wave 2a)
// License: BUSL-1.1
//
// Closes the structural squat attack: at publish time, the registry GETs
// `<endpoint>/.well-known/swarmwage-verify?nonce=N` and verifies that the
// signed response is bound to the listing's agent_id. An attacker pointing
// a listing at a third-party endpoint cannot produce the matching signature
// without the third party's private key, so the listing is rejected before
// it ever shows up in search results.

import { randomUUID } from "node:crypto";

import { ENDPOINT_VERIFY_PATH, type AgentId, type Hex } from "@swarmwage/agent-sdk";

import { verifyTypedPayload } from "./auth.js";

export type ChallengeResult =
  | { ok: true }
  | { ok: false; reason: string };

export interface ChallengeOptions {
  /** Override the global fetch (used in tests to stub the network). */
  fetchFn?: typeof fetch;
  /** Override nonce generation (deterministic in tests). */
  nonceFn?: () => string;
  /** Wall-clock budget for the verify GET, in ms. Defaults to 5000. */
  timeoutMs?: number;
}

/**
 * Issue a nonce-challenge to the endpoint and verify the signed response.
 *
 * On failure we return a structured reason instead of throwing — the caller
 * (POST /v1/listings) decides whether to reject (enforce mode) or just
 * log (soft mode) based on configuration.
 */
export async function challengeEndpointOwnership(
  endpoint: string,
  agentId: AgentId,
  opts: ChallengeOptions = {},
): Promise<ChallengeResult> {
  const fetchFn = opts.fetchFn ?? globalThis.fetch;
  const nonce = (opts.nonceFn ?? randomUUID)();
  const timeoutMs = opts.timeoutMs ?? 5000;

  let base: URL;
  try {
    base = new URL(endpoint);
  } catch {
    return { ok: false, reason: "endpoint is not a valid URL" };
  }
  // Build verify URL by appending the well-known path to the endpoint's
  // origin. We deliberately ignore the endpoint's path segment — every
  // seller serves /.well-known at the host root regardless of the hire
  // path they advertise.
  const verifyUrl = new URL(ENDPOINT_VERIFY_PATH, base.origin);
  verifyUrl.searchParams.set("nonce", nonce);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetchFn(verifyUrl.toString(), {
      method: "GET",
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
  } catch (err) {
    return {
      ok: false,
      reason: `endpoint unreachable: ${(err as Error).message ?? "fetch failed"}`,
    };
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    return { ok: false, reason: `verify endpoint returned HTTP ${res.status}` };
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { ok: false, reason: "verify endpoint did not return JSON" };
  }
  if (typeof body !== "object" || body === null) {
    return { ok: false, reason: "verify response is not an object" };
  }
  const b = body as Record<string, unknown>;
  if (typeof b.nonce !== "string" || b.nonce !== nonce) {
    return { ok: false, reason: "verify response nonce does not match" };
  }
  if (
    typeof b.agent_id !== "string" ||
    b.agent_id.toLowerCase() !== agentId.toLowerCase()
  ) {
    return { ok: false, reason: "verify response agent_id does not match" };
  }
  if (
    typeof b.signature !== "string" ||
    !/^0x[a-fA-F0-9]+$/.test(b.signature)
  ) {
    return { ok: false, reason: "verify response signature is missing or malformed" };
  }

  const valid = await verifyTypedPayload(
    agentId,
    { agent_id: agentId, nonce },
    b.signature as Hex,
  );
  if (!valid) {
    return { ok: false, reason: "signature does not verify against agent_id" };
  }
  return { ok: true };
}
