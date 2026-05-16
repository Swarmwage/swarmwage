// © 2026 Swarmwage. MIT.
// Swarmwage seller-linkedin-enrich — server-side verification mirror.
//
// These are the same checks the buyer-side SDK verifier runs on the
// canonical output. Running them here lets us reject malformed responses
// before charging — and lets us populate the `verification` block on
// every receipt with deterministic, auditable signals.

export interface VerificationCheckResult {
  name: string;
  passed: boolean;
  detail?: string;
}

export interface VerifyOutput {
  profile: unknown;
}

export interface VerifyResult {
  checks: VerificationCheckResult[];
  all_passed: boolean;
}

export function verifyProfile(out: VerifyOutput): VerifyResult {
  const checks: VerificationCheckResult[] = [];

  // 1. output_is_object — top-level shape
  const isObject =
    out !== null && typeof out === "object" && !Array.isArray(out);
  checks.push({ name: "output_is_object", passed: isObject });

  // 2. profile_is_object
  const profile = (out as { profile?: unknown }).profile;
  const profileIsObject =
    profile !== null && typeof profile === "object" && !Array.isArray(profile);
  checks.push({ name: "profile_is_object", passed: profileIsObject });

  // 3. profile_has_url — required minimum field
  const url = profileIsObject ? (profile as { url?: unknown }).url : undefined;
  const urlOk = typeof url === "string" && url.length > 0;
  checks.push({
    name: "profile_has_url",
    passed: urlOk,
    detail: urlOk ? undefined : `got: ${typeof url}`,
  });

  // 4. profile_has_name — required minimum field
  const name = profileIsObject
    ? (profile as { name?: unknown }).name
    : undefined;
  const nameOk = typeof name === "string" && name.length > 0;
  checks.push({
    name: "profile_has_name",
    passed: nameOk,
    detail: nameOk ? undefined : `got: ${typeof name}`,
  });

  // 5. source_is_apify — provenance pin
  const source = profileIsObject
    ? (profile as { source?: unknown }).source
    : undefined;
  const sourceOk = source === "apify";
  checks.push({
    name: "source_is_apify",
    passed: sourceOk,
    detail: sourceOk ? undefined : `got: ${typeof source === "string" ? source : typeof source}`,
  });

  return {
    checks,
    all_passed: checks.every((c) => c.passed),
  };
}
