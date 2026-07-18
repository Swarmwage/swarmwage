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
import { firstForbiddenResolvedIp, type ResolveFn } from "./ip-guard.js";

export type ChallengeResult =
  | { ok: true }
  | { ok: false; reason: string };

/** Cap on the verify response body — it carries a tiny signed-nonce JSON. */
const MAX_VERIFY_BODY_BYTES = 16 * 1024;

export interface ChallengeOptions {
  /** Override the global fetch (used in tests to stub the network). */
  fetchFn?: typeof fetch;
  /** Override nonce generation (deterministic in tests). */
  nonceFn?: () => string;
  /** Wall-clock budget for the verify GET, in ms. Defaults to 5000. */
  timeoutMs?: number;
  /** Override DNS resolution for the SSRF host guard (tests). */
  resolveFn?: ResolveFn;
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

  // SSRF guard: reject before issuing the request if the host resolves to a
  // private / loopback / link-local / metadata address. Skipped when a fetch
  // stub owns the network (tests); a stubbed `resolveFn` still exercises it.
  if (opts.fetchFn === undefined || opts.resolveFn !== undefined) {
    let forbiddenIp: string | null;
    try {
      forbiddenIp = await firstForbiddenResolvedIp(
        verifyUrl.hostname,
        opts.resolveFn,
      );
    } catch (err) {
      return {
        ok: false,
        reason: `endpoint DNS resolution failed: ${(err as Error).message ?? "lookup failed"}`,
      };
    }
    if (forbiddenIp !== null) {
      return {
        ok: false,
        reason: `endpoint resolves to forbidden IP ${forbiddenIp} (SSRF guard)`,
      };
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetchFn(verifyUrl.toString(), {
      method: "GET",
      signal: controller.signal,
      // Do not follow redirects: an allowlisted host that 3xx-redirects to an
      // internal address is the classic SSRF bypass. Treat any 3xx as failure.
      redirect: "manual",
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

  if (res.status >= 300 && res.status < 400) {
    return {
      ok: false,
      reason: `verify endpoint redirected (HTTP ${res.status}); redirects are not followed (SSRF guard)`,
    };
  }
  if (!res.ok) {
    return { ok: false, reason: `verify endpoint returned HTTP ${res.status}` };
  }
  const declaredLen = Number(res.headers.get("content-length") ?? "");
  if (Number.isFinite(declaredLen) && declaredLen > MAX_VERIFY_BODY_BYTES) {
    return { ok: false, reason: "verify response too large" };
  }
  const text = await readCappedBody(res, MAX_VERIFY_BODY_BYTES);
  if (text === null) {
    return { ok: false, reason: "verify response too large" };
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
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

/**
 * Read a response body as text, aborting once `max` bytes are exceeded.
 * Returns null when the body is over the cap. Streaming (rather than
 * `res.text()`) so a malicious seller cannot OOM the registry by streaming a
 * huge body under a small/absent content-length.
 */
async function readCappedBody(
  res: Response,
  max: number,
): Promise<string | null> {
  if (!res.body) {
    const t = await res.text();
    return t.length > max ? null : t;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}
