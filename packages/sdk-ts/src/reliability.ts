// Swarmwage Agent SDK — external x402 reliability controls
// Protocol: swarmwage/v0.1
// License: MIT
//
// Client-observed reliability records are best-effort evidence for raw
// third-party x402 calls. They are separate from seller-signed receipts.

/**
 * Decide whether client-observed external x402 reliability submission is
 * enabled. Defaults ON; opt out with `SWARMWAGE_RELIABILITY=0`.
 */
export function isReliabilityEnabled(
  enabled: boolean | undefined,
  env: Record<string, string | undefined> = (typeof process !== "undefined"
    ? (process.env as Record<string, string | undefined>)
    : {}),
): boolean {
  if (enabled !== undefined) return enabled;
  const raw = env.SWARMWAGE_RELIABILITY;
  if (raw === undefined) return true;
  const v = raw.trim().toLowerCase();
  if (v === "0" || v === "false" || v === "off" || v === "no") return false;
  return true;
}
