// Swarmwage Registry — SSRF IP guard unit tests (P1-B, 2026-06-24).
// License: BUSL-1.1

import { test } from "node:test";
import assert from "node:assert/strict";

import { isForbiddenIp, firstForbiddenResolvedIp } from "../ip-guard.js";

test("isForbiddenIp: private / loopback / link-local / reserved IPv4 are forbidden", () => {
  for (const ip of [
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254", // cloud metadata
    "0.0.0.0",
    "100.64.0.1", // CGNAT
    "224.0.0.1", // multicast
    "240.0.0.1", // reserved
  ]) {
    assert.equal(isForbiddenIp(ip), true, `${ip} must be forbidden`);
  }
});

test("isForbiddenIp: public IPv4 just outside the blocked ranges is allowed", () => {
  for (const ip of [
    "8.8.8.8",
    "1.1.1.1",
    "172.15.0.1", // just below 172.16/12
    "172.32.0.1", // just above 172.16/12
    "192.169.0.1", // just outside 192.168/16
    "100.63.255.255", // just below CGNAT
  ]) {
    assert.equal(isForbiddenIp(ip), false, `${ip} must be allowed`);
  }
});

test("isForbiddenIp: IPv6 loopback / ULA / link-local / multicast are forbidden", () => {
  for (const ip of ["::1", "::", "fe80::1", "fc00::1", "fd12:3456::1", "ff02::1", "[::1]"]) {
    assert.equal(isForbiddenIp(ip), true, `${ip} must be forbidden`);
  }
});

test("isForbiddenIp: public IPv6 is allowed", () => {
  assert.equal(isForbiddenIp("2001:4860:4860::8888"), false);
});

test("isForbiddenIp: IPv4-mapped IPv6 is classified by the embedded v4", () => {
  assert.equal(isForbiddenIp("::ffff:127.0.0.1"), true);
  assert.equal(isForbiddenIp("::ffff:10.0.0.1"), true);
  assert.equal(isForbiddenIp("::ffff:8.8.8.8"), false); // public mapped stays allowed
});

test("isForbiddenIp: IPv4-compatible / NAT64 / 6to4 embedded-v4 forms are forbidden", () => {
  for (const ip of [
    "::169.254.169.254", // IPv4-compatible (dotted)
    "::a9fe:a9fe", // same, hex form (how new URL() normalizes it)
    "::127.0.0.1",
    "64:ff9b::a9fe:a9fe", // NAT64 of 169.254.169.254
    "2002:c0a8:0101::1", // 6to4 embedding 192.168.1.1
  ]) {
    assert.equal(isForbiddenIp(ip), true, `${ip} must be forbidden`);
  }
});

test("isForbiddenIp: unparseable input fails closed (forbidden)", () => {
  assert.equal(isForbiddenIp("not-an-ip"), true);
  assert.equal(isForbiddenIp(""), true);
});

test("firstForbiddenResolvedIp: literal IP host is checked directly", async () => {
  assert.equal(await firstForbiddenResolvedIp("10.0.0.5"), "10.0.0.5");
  assert.equal(await firstForbiddenResolvedIp("[::1]"), "::1");
  assert.equal(await firstForbiddenResolvedIp("8.8.8.8"), null);
});

test("firstForbiddenResolvedIp: hostname resolving to a private IP is caught", async () => {
  const resolveFn = async () => ["203.0.113.10", "10.0.0.9"]; // public + private
  assert.equal(await firstForbiddenResolvedIp("rebind.evil.test", resolveFn), "10.0.0.9");
});

test("firstForbiddenResolvedIp: hostname resolving only to public IPs passes", async () => {
  const resolveFn = async () => ["203.0.113.10", "8.8.8.8"];
  assert.equal(await firstForbiddenResolvedIp("good.example", resolveFn), null);
});

test("firstForbiddenResolvedIp: empty resolution fails closed", async () => {
  const resolveFn = async () => [];
  assert.equal(await firstForbiddenResolvedIp("ghost.example", resolveFn), "ghost.example");
});
