// Swarmwage Agent SDK — canonicalization tests
// License: MIT
//
// Proves the deep canonicalization fix: nested fields are now part of the
// signed bytes, and the value domain is enforced. Cross-language byte-parity
// with the Python SDK is checked separately (the canon-parity step) against the
// identical FIXTURE below.

import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalize, CanonicalizationError } from "../canonical.js";

// Shared fixture — kept byte-identical to sdk-py/tests/test_canonical.py.
const FIXTURE = {
  protocol_version: "swarmwage/v0.1",
  hire_id: "rcpt_abc",
  agent_id: "0x1111111111111111111111111111111111111111",
  buyer: "0x2222222222222222222222222222222222222222",
  capability: "image.generate.photorealistic.png",
  amount_usdc_atomic: "20000",
  network: "base",
  tx_hash: "0x" + "00".repeat(32),
  completed_at: "2026-06-23T10:00:00.000Z",
  max_latency_ms: 15000,
  verification: { all_passed: false, checks: { non_empty_result: true } },
};

test("keys sorted recursively", () => {
  assert.equal(canonicalize({ b: 1, a: { z: 1, y: 2 } }), '{"a":{"y":2,"z":1},"b":1}');
});

test("nested verification is covered (the fix)", () => {
  const base = canonicalize(FIXTURE);
  const tampered = {
    ...FIXTURE,
    verification: { all_passed: true, checks: { non_empty_result: true } },
  };
  assert.notEqual(canonicalize(tampered), base);
  assert.ok(base.includes('"all_passed":false'));
  assert.ok(canonicalize(tampered).includes('"all_passed":true'));
});

test("rejects float", () => {
  assert.throws(() => canonicalize({ x: 1.5 }), CanonicalizationError);
});

test("rejects NaN and Infinity", () => {
  assert.throws(() => canonicalize({ x: NaN }), CanonicalizationError);
  assert.throws(() => canonicalize({ x: Infinity }), CanonicalizationError);
});

test("rejects bigint, Date, undefined", () => {
  assert.throws(() => canonicalize({ x: 1n }), CanonicalizationError);
  assert.throws(() => canonicalize({ x: new Date() }), CanonicalizationError);
  assert.throws(() => canonicalize({ x: undefined }), CanonicalizationError);
});

test("integer, bool, null", () => {
  assert.equal(canonicalize({ n: 0, b: true, z: null }), '{"b":true,"n":0,"z":null}');
});

test("rejects unsafe integer (> 2^53-1 — would round, diverging from Python)", () => {
  assert.throws(() => canonicalize({ x: 9007199254740993 }), CanonicalizationError);
});

test("rejects non-ASCII object key (UTF-16 vs code-point sort divergence)", () => {
  assert.throws(() => canonicalize({ "é": 1 }), CanonicalizationError);
  assert.throws(() => canonicalize({ "\u{1F600}": 1 }), CanonicalizationError);
});

test("rejects sparse array hole", () => {
  // eslint-disable-next-line no-sparse-arrays
  assert.throws(() => canonicalize({ x: [1, , 3] }), CanonicalizationError);
});

test("rejects lone surrogate in string value (Python can't UTF-8 encode it)", () => {
  assert.throws(() => canonicalize({ x: "\uD800" }), CanonicalizationError);
});

test("allows well-formed astral char in string value (byte-parity safe)", () => {
  assert.equal(canonicalize({ x: "\u{1F600}" }), '{"x":"😀"}');
});
