// Swarmwage Registry — SSRF IP guard
// License: BUSL-1.1
//
// The endpoint-ownership challenge (endpoint-verify.ts) makes the registry
// issue a server-side GET to a seller-controlled URL. Without a guard a
// seller can publish an endpoint whose host resolves to a private/loopback/
// link-local address and turn the registry into an SSRF proxy onto its own
// network (loopback services, cloud metadata). This module classifies an IP
// as "not safely routable to a public host" — the same set the Python SDK's
// `_is_forbidden_ip` rejects, here backed by node:net BlockList.

import { BlockList, isIPv4, isIPv6 } from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";

const forbidden = new BlockList();
// IPv4 — loopback, private (RFC1918), link-local (IMDS), CGNAT, this-network,
// multicast, reserved.
forbidden.addSubnet("0.0.0.0", 8, "ipv4");
forbidden.addSubnet("10.0.0.0", 8, "ipv4");
forbidden.addSubnet("100.64.0.0", 10, "ipv4");
forbidden.addSubnet("127.0.0.0", 8, "ipv4");
forbidden.addSubnet("169.254.0.0", 16, "ipv4");
forbidden.addSubnet("172.16.0.0", 12, "ipv4");
forbidden.addSubnet("192.168.0.0", 16, "ipv4");
forbidden.addSubnet("224.0.0.0", 4, "ipv4");
forbidden.addSubnet("240.0.0.0", 4, "ipv4");
// IPv6 — unspecified, loopback, ULA, link-local, multicast.
forbidden.addAddress("::1", "ipv6");
forbidden.addSubnet("fc00::", 7, "ipv6");
forbidden.addSubnet("fe80::", 10, "ipv6");
forbidden.addSubnet("ff00::", 8, "ipv6");
// IPv4-compatible `::a.b.c.d` (deprecated; covers `::` and `::1` too) — a
// transport could route the embedded v4 to a private host. BlockList does
// NOT cross-family these the way it does `::ffff:` mapped, so block the range.
forbidden.addSubnet("::", 96, "ipv6");
// NAT64 well-known prefix and 6to4 — both embed an arbitrary IPv4 that a
// gateway may route to a private/metadata address.
forbidden.addSubnet("64:ff9b::", 96, "ipv6");
forbidden.addSubnet("2002::", 16, "ipv6");

/**
 * True when `ip` is a literal address that must not receive registry-issued
 * traffic. Fails closed: anything not parseable as an IP is treated as
 * forbidden.
 */
export function isForbiddenIp(ip: string): boolean {
  let addr = ip.trim();
  if (addr.startsWith("[") && addr.endsWith("]")) addr = addr.slice(1, -1);
  // IPv4-mapped IPv6 (`::ffff:1.2.3.4`) — classify by the embedded IPv4.
  const mapped = addr.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
  if (mapped) addr = mapped[1]!;
  if (isIPv4(addr)) return forbidden.check(addr, "ipv4");
  if (isIPv6(addr)) return forbidden.check(addr, "ipv6");
  return true;
}

/** Resolve a hostname to its IP addresses. Injectable for tests. */
export type ResolveFn = (host: string) => Promise<string[]>;

const defaultResolve: ResolveFn = async (host) => {
  const infos = await dnsLookup(host, { all: true });
  return infos.map((i) => i.address);
};

/**
 * Returns the first forbidden IP a host resolves to, or null if all resolved
 * addresses are public. A literal-IP host is checked directly. Throws if DNS
 * resolution fails.
 *
 * ponytail: resolve-then-check leaves a DNS-rebinding TOCTOU race (host
 * resolves public here, private at fetch connect time). Combined with the
 * caller's no-follow-redirect + parse-time literal-IP block, the documented
 * SSRF exploits are closed; closing the race needs connection pinning (undici
 * dispatcher / node:http `lookup` hook) — the upgrade path when this endpoint
 * faces a credential-bearing metadata service.
 */
export async function firstForbiddenResolvedIp(
  host: string,
  resolveFn: ResolveFn = defaultResolve,
): Promise<string | null> {
  const literal = host.startsWith("[") && host.endsWith("]")
    ? host.slice(1, -1)
    : host;
  if (isIPv4(literal) || isIPv6(literal)) {
    return isForbiddenIp(literal) ? literal : null;
  }
  const addresses = await resolveFn(host);
  // Fail closed: a host that resolves to nothing must not be treated as
  // public. (The default resolver throws on NXDOMAIN; this guards a future
  // resolveFn — e.g. dns.resolve4 — that returns [] for a missing record.)
  if (addresses.length === 0) return host;
  for (const a of addresses) {
    if (isForbiddenIp(a)) return a;
  }
  return null;
}
