// Swarmwage Agent SDK — facilitator URL resolution
// Resolves the x402 facilitator URL the SDK should advertise on every paid
// request. Default ON, opt-out via env `SWARMWAGE_FACILITATOR=0` (also
// `false`/`off`/`no`, case-insensitive) or config `facilitatorUrl: null`.
// License: MIT

/**
 * Default URL of the Swarmwage Facilitator.
 *
 * Gas-relay-only x402 service: pays ETH to invoke
 * `USDC.transferWithAuthorization()` on behalf of the buyer. Funds move
 * directly from buyer to seller — the facilitator never custodies USDC.
 */
export const SWARMWAGE_FACILITATOR_URL = "https://facilitator.swarmwage.com";

/**
 * Header name used to advertise the buyer's preferred facilitator to a
 * Swarmwage-aware seller. The seller MAY use this URL for `verify`/`settle`;
 * sellers that ignore it fall back to their own facilitator.
 */
export const SWARMWAGE_FACILITATOR_HEADER = "X-Swarmwage-Facilitator";

export interface FacilitatorResolverInput {
  /**
   * Explicit facilitator URL or opt-out marker.
   *
   * - `undefined` (or omitted): use default unless env opts out
   * - `null`: opt out (use seller's facilitator from the 402 challenge)
   * - non-empty string: use this URL verbatim
   */
  facilitatorUrl?: string | null;
}

/**
 * Resolve the facilitator URL the SDK will advertise on paid requests.
 *
 * Precedence:
 *  1. `env.SWARMWAGE_FACILITATOR` parsed as a falsy marker (`0`, `false`,
 *     `off`, `no`, case-insensitive, trimmed) → returns `null` (opt-out).
 *  2. `config.facilitatorUrl === null` → returns `null` (opt-out).
 *  3. `config.facilitatorUrl` is a non-empty string → returns it verbatim.
 *  4. Otherwise → returns {@link SWARMWAGE_FACILITATOR_URL}.
 *
 * Returning `null` means: use the seller's facilitator as advertised in the
 * x402 402 challenge (the pre-default behavior).
 */
export function resolveFacilitatorUrl(
  config: FacilitatorResolverInput = {},
  env: Record<string, string | undefined> = typeof process !== "undefined"
    ? process.env
    : {},
): string | null {
  if (isFalsy(env.SWARMWAGE_FACILITATOR)) return null;
  if (config.facilitatorUrl === null) return null;
  if (typeof config.facilitatorUrl === "string") {
    const trimmed = config.facilitatorUrl.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return SWARMWAGE_FACILITATOR_URL;
}

function isFalsy(value: string | undefined): boolean {
  if (value === undefined) return false;
  const v = value.trim().toLowerCase();
  return v === "0" || v === "false" || v === "off" || v === "no";
}
