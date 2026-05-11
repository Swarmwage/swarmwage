// Swarmwage MCP — boot-time update notifier
// License: MIT
//
// Fetches the latest published version of @swarmwage/mcp from the npm
// registry once at startup, compares it to the running version, and
// writes a one-line stderr notice if a newer version exists. Strictly
// non-blocking: the MCP stdio loop never waits on this, and every
// error path is swallowed silently — a flaky network must not break a
// working MCP server.
//
// Opt-out: set env SWARMWAGE_NO_UPDATE_CHECK=1 (also accepts: true, on, yes).

import { VERSION } from "./constants.js";

const NPM_REGISTRY_URL = "https://registry.npmjs.org/@swarmwage/mcp/latest";
const TIMEOUT_MS = 2_000;

function isOptedOut(): boolean {
  const raw = process.env.SWARMWAGE_NO_UPDATE_CHECK;
  if (!raw) return false;
  return /^(1|true|on|yes)$/i.test(raw.trim());
}

/** Compare two `x.y.z` strings. Returns +1, 0, -1. Returns 0 on parse failure. */
function compareSemver(a: string, b: string): number {
  if (!/^\d+\.\d+\.\d+/.test(a) || !/^\d+\.\d+\.\d+/.test(b)) return 0;
  const pa = a.split(".").map((n) => parseInt(n, 10));
  const pb = b.split(".").map((n) => parseInt(n, 10));
  for (let i = 0; i < 3; i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return da > db ? 1 : -1;
  }
  return 0;
}

/**
 * Fire-and-forget update probe. Caller does not await. Resolves after at most
 * `TIMEOUT_MS` regardless of network state. Never throws.
 */
export async function checkForUpdate(): Promise<void> {
  if (isOptedOut()) return;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(NPM_REGISTRY_URL, {
        signal: ctrl.signal,
        headers: { Accept: "application/json" },
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) return;
    const data = (await res.json()) as { version?: string };
    const latest = data.version;
    if (typeof latest !== "string") return;
    if (compareSemver(latest, VERSION) <= 0) return;
    process.stderr.write(
      `swarmwage-mcp: update available ${VERSION} → ${latest}. ` +
        `Run: npx -y @swarmwage/mcp@latest --init to refresh, or pin the new version in your host config.\n` +
        `(set SWARMWAGE_NO_UPDATE_CHECK=1 to silence this notice)\n`,
    );
  } catch {
    // Silent: no network, npm down, slow, malformed JSON — never block.
  }
}
