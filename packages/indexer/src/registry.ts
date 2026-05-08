// Swarmwage Indexer — registry client (recipient address → agent_id)
// License: BUSL-1.1
//
// Resolves a recipient EVM address to a Swarmwage `agent_id` by querying
// the public registry. Results are cached in-process for `cacheTtlMs`
// (default 60s) to keep RPC pressure low while still picking up new
// listings within a minute.
//
// The endpoint contract assumed here is:
//
//   GET ${REGISTRY_URL}/v1/listings?recipient=0x...
//   → 200 { agent_id: "string", recipient: "0x..." }
//   → 404 (no listing maps to this address)
//
// TODO: confirm the exact shape with `packages/registry/src/routes/*` once
// the recipient-lookup endpoint is finalised. On any non-2xx response the
// resolver returns `null` and the caller proceeds with `recipient_agent_id
// = null` — registry availability MUST NOT block indexing.

export interface RegistryResolver {
  resolveAgentId(address: string): Promise<string | null>;
}

interface CacheEntry {
  value: string | null;
  expiresAt: number;
}

export interface RegistryClientOptions {
  baseUrl: string;
  cacheTtlMs?: number;
  /** Override `fetch` for testing. Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Per-request timeout in ms. Defaults to 5_000. */
  timeoutMs?: number;
}

export function createRegistryClient(
  opts: RegistryClientOptions,
): RegistryResolver {
  const baseUrl = opts.baseUrl.replace(/\/+$/, "");
  const cacheTtlMs = opts.cacheTtlMs ?? 60_000;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const cache = new Map<string, CacheEntry>();

  return {
    async resolveAgentId(address: string): Promise<string | null> {
      const key = address.toLowerCase();
      const now = Date.now();
      const cached = cache.get(key);
      if (cached && cached.expiresAt > now) {
        return cached.value;
      }

      const url = `${baseUrl}/v1/listings?recipient=${encodeURIComponent(address)}`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let resolved: string | null = null;
      try {
        const res = await fetchImpl(url, { signal: controller.signal });
        if (res.ok) {
          const body = (await res.json()) as { agent_id?: unknown };
          if (typeof body.agent_id === "string" && body.agent_id.length > 0) {
            resolved = body.agent_id;
          }
        }
        // Any non-2xx (including 404) collapses to `null` — registry
        // availability MUST NOT block indexing.
      } catch {
        resolved = null;
      } finally {
        clearTimeout(timer);
      }

      cache.set(key, { value: resolved, expiresAt: now + cacheTtlMs });
      return resolved;
    },
  };
}
