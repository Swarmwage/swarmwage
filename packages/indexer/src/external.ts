// Swarmwage Indexer — external address attribution
// License: BUSL-1.1
//
// Resolves a recipient EVM address to an *external* (non-Swarmwage) label
// loaded from a static seed file. This lets the indexer attribute on-chain
// USDC volume to known third-party x402 endpoints (e.g. addresses sourced from
// a public x402 catalog) WITHOUT registering them as Swarmwage agents — the
// attribution is kept in `recipient_source` / `recipient_label`, separate from
// `recipient_agent_id`.
//
// The seed file path is configured out-of-band (`EXTERNAL_ADDRESSES_PATH`)
// and intentionally NOT committed to this repository: the code is generic,
// the dataset is operator-supplied. When no path is set or the file is
// missing/malformed, this resolver is a safe no-op — external attribution is
// best-effort and MUST NEVER block indexing.
//
// Expected seed shape (array; unknown fields ignored):
//
//   [{ "address": "0x...", "source": "example-catalog",
//      "label": "Example Service", "category": "Search" }, ...]

import { readFileSync } from "node:fs";

export interface ExternalAttribution {
  /** Provenance of the address set, e.g. "example-catalog". */
  source: string;
  /** Human label for the endpoint/service, e.g. "Example Service". */
  label: string;
  /** Optional category, e.g. "Search". Empty string when unknown. */
  category: string;
}

export interface ExternalResolver {
  /** Lookup by address (case-insensitive). Returns `null` when unknown. */
  resolve(address: string): ExternalAttribution | null;
  /** Number of addresses loaded. Useful for `/metrics` and boot logs. */
  size(): number;
}

export interface ExternalResolverOptions {
  /** Filesystem path to the seed JSON. When undefined, a no-op resolver is returned. */
  path?: string;
  /** Optional structured logger for load diagnostics. */
  logger?: {
    info(msg: string, meta?: Record<string, unknown>): void;
    warn(msg: string, meta?: Record<string, unknown>): void;
  };
  /** Override the file reader for testing. Defaults to `node:fs` `readFileSync`. */
  readFileImpl?: (path: string) => string;
}

interface SeedEntry {
  address?: unknown;
  source?: unknown;
  label?: unknown;
  category?: unknown;
}

const NOOP: ExternalResolver = {
  resolve: () => null,
  size: () => 0,
};

/**
 * Build an `ExternalResolver` from a seed file. Never throws: any read or
 * parse failure collapses to the no-op resolver so indexing proceeds.
 */
export function createExternalResolver(
  opts: ExternalResolverOptions = {},
): ExternalResolver {
  if (!opts.path) return NOOP;

  const read = opts.readFileImpl ?? ((p: string) => readFileSync(p, "utf8"));
  let raw: string;
  try {
    raw = read(opts.path);
  } catch (err) {
    opts.logger?.warn("indexer.external.load_failed", {
      path: opts.path,
      error: (err as Error).message,
    });
    return NOOP;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    opts.logger?.warn("indexer.external.parse_failed", {
      path: opts.path,
      error: (err as Error).message,
    });
    return NOOP;
  }

  if (!Array.isArray(parsed)) {
    opts.logger?.warn("indexer.external.not_an_array", { path: opts.path });
    return NOOP;
  }

  const map = new Map<string, ExternalAttribution>();
  for (const entry of parsed as SeedEntry[]) {
    if (typeof entry?.address !== "string") continue;
    const key = entry.address.toLowerCase();
    if (key.length === 0 || map.has(key)) continue;
    map.set(key, {
      source: typeof entry.source === "string" ? entry.source : "external",
      label: typeof entry.label === "string" ? entry.label : "",
      category: typeof entry.category === "string" ? entry.category : "",
    });
  }

  opts.logger?.info("indexer.external.loaded", {
    path: opts.path,
    addresses: map.size,
  });

  return {
    resolve(address: string): ExternalAttribution | null {
      return map.get(address.toLowerCase()) ?? null;
    },
    size(): number {
      return map.size;
    },
  };
}
