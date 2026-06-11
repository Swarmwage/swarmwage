// Swarmwage Registry — seller endpoint admission policy
// License: BUSL-1.1

/**
 * Returns a non-null human-readable reason when the given endpoint URL points
 * to a host the registry must NOT accept as a public seller endpoint, or null
 * when the URL passes. Closes the SSRF surface a malicious seller would
 * otherwise have by publishing a listing whose endpoint is a loopback /
 * private / cloud-metadata address — the moment a buyer hires that listing,
 * the buyer SDK fetches the URL from inside the buyer's network and exposes
 * services (IMDS credentials, internal admin panels) that only the buyer
 * itself can reach. We block at publish-time so the listing never appears in
 * search results.
 */
export function blockedEndpointReason(endpoint: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    return "endpoint is not a valid URL";
  }
  if (parsed.username !== "" || parsed.password !== "") {
    return "endpoint must not contain userinfo (user:pass@host)";
  }
  const raw = parsed.hostname.toLowerCase();
  // IPv6 hostnames arrive bracketed in `URL.hostname` — strip for matching.
  const host =
    raw.startsWith("[") && raw.endsWith("]") ? raw.slice(1, -1) : raw;
  if (
    host === "localhost" ||
    host === "localhost.localdomain" ||
    host === "ip6-localhost" ||
    host === "ip6-loopback" ||
    host === "::1" ||
    host === "0.0.0.0"
  ) {
    return "endpoint hostname is loopback / localhost";
  }
  if (
    host === "metadata.google.internal" ||
    host === "metadata.azure.com" ||
    host === "instance-data" ||
    host === "instance-data.ec2.internal" ||
    host.endsWith(".internal")
  ) {
    return "endpoint hostname is a known cloud metadata service";
  }
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const a = Number(ipv4[1]);
    const b = Number(ipv4[2]);
    if ([a, b, Number(ipv4[3]), Number(ipv4[4])].some((n) => n < 0 || n > 255)) {
      return "endpoint IP literal is malformed";
    }
    // 10.0.0.0/8 private
    if (a === 10) return "endpoint IP is in private range 10.0.0.0/8";
    // 172.16.0.0/12 private
    if (a === 172 && b >= 16 && b <= 31)
      return "endpoint IP is in private range 172.16.0.0/12";
    // 192.168.0.0/16 private
    if (a === 192 && b === 168)
      return "endpoint IP is in private range 192.168.0.0/16";
    // 127.0.0.0/8 loopback
    if (a === 127) return "endpoint IP is loopback (127.0.0.0/8)";
    // 169.254.0.0/16 link-local — AWS/GCP/Azure IMDS lives here
    if (a === 169 && b === 254)
      return "endpoint IP is link-local (169.254.0.0/16) — cloud metadata";
    // 0.0.0.0/8 "this network", multicast, class E reserved
    if (a === 0) return "endpoint IP is in 0.0.0.0/8";
    if (a >= 224) return "endpoint IP is multicast or reserved (>=224.0.0.0)";
  }
  // IPv6 ULA fc00::/7 + link-local fe80::/10 (lowercase already)
  if (/^f[cd][0-9a-f]{0,2}:/.test(host)) {
    return "endpoint IPv6 is in ULA range fc00::/7";
  }
  if (host.startsWith("fe80:") || host.startsWith("fe90:") || host.startsWith("fea0:") || host.startsWith("feb0:")) {
    return "endpoint IPv6 is link-local fe80::/10";
  }
  return null;
}
