// Swarmwage Agent SDK — verification tests
// License: MIT

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { verify } from "../verification.js";

const CAP = "audio.transcribe.json-with-timestamps";

function findCheck(
  res: { checks: { name: string; passed: boolean }[] },
  name: string,
) {
  return res.checks.find((c) => c.name === name);
}

describe(`verify(${CAP})`, () => {
  it("happy-path: language='it' + 3 monotonic segments → all_passed", () => {
    const output = {
      language: "it",
      segments: [
        { start_ms: 0, end_ms: 1000, text: "uno" },
        { start_ms: 1000, end_ms: 2000, text: "due" },
        { start_ms: 2000, end_ms: 3000, text: "tre" },
      ],
    };
    const res = verify(CAP, {}, output);
    assert.equal(res.all_passed, true, JSON.stringify(res));
    assert.equal(findCheck(res, "output_is_object")?.passed, true);
    assert.equal(findCheck(res, "language_is_iso_639_1")?.passed, true);
    assert.equal(findCheck(res, "segments_is_array")?.passed, true);
    assert.equal(findCheck(res, "segments_nonempty")?.passed, true);
    assert.equal(findCheck(res, "segments_monotonic_timestamps")?.passed, true);
  });

  it("rejects ISO 639-3 (3-letter) codes — only 639-1 accepted per CAPABILITIES.md", () => {
    const output = {
      language: "cmn",
      segments: [{ start_ms: 0, end_ms: 100, text: "x" }],
    };
    const res = verify(CAP, {}, output);
    assert.equal(findCheck(res, "language_is_iso_639_1")?.passed, false);
  });

  it("language: missing field → language_is_iso_639_1 fails", () => {
    const output = {
      segments: [{ start_ms: 0, end_ms: 100, text: "x" }],
    };
    const res = verify(CAP, {}, output);
    assert.equal(res.all_passed, false);
    assert.equal(findCheck(res, "language_is_iso_639_1")?.passed, false);
  });

  it("language: non-string (number) → fails", () => {
    const output = {
      language: 42,
      segments: [{ start_ms: 0, end_ms: 100, text: "x" }],
    };
    const res = verify(CAP, {}, output);
    assert.equal(findCheck(res, "language_is_iso_639_1")?.passed, false);
  });

  it("language: empty string → fails", () => {
    const output = {
      language: "",
      segments: [{ start_ms: 0, end_ms: 100, text: "x" }],
    };
    const res = verify(CAP, {}, output);
    assert.equal(findCheck(res, "language_is_iso_639_1")?.passed, false);
  });

  it("language: full-name 'italian' → fails (must be ISO code)", () => {
    const output = {
      language: "italian",
      segments: [{ start_ms: 0, end_ms: 100, text: "x" }],
    };
    const res = verify(CAP, {}, output);
    assert.equal(findCheck(res, "language_is_iso_639_1")?.passed, false);
  });

  it("language: uppercase 'IT' → fails (must be lowercase)", () => {
    const output = {
      language: "IT",
      segments: [{ start_ms: 0, end_ms: 100, text: "x" }],
    };
    const res = verify(CAP, {}, output);
    assert.equal(findCheck(res, "language_is_iso_639_1")?.passed, false);
  });

  it("segments: monotonic violation → segments_monotonic_timestamps fails", () => {
    const output = {
      language: "it",
      segments: [
        { start_ms: 0, end_ms: 1000, text: "uno" },
        { start_ms: 2000, end_ms: 3000, text: "tre" },
        { start_ms: 1000, end_ms: 2000, text: "due" }, // out-of-order
      ],
    };
    const res = verify(CAP, {}, output);
    assert.equal(res.all_passed, false);
    assert.equal(findCheck(res, "segments_monotonic_timestamps")?.passed, false);
  });

  it("segments: empty array → segments_nonempty fails", () => {
    const output = { language: "it", segments: [] };
    const res = verify(CAP, {}, output);
    assert.equal(res.all_passed, false);
    assert.equal(findCheck(res, "segments_is_array")?.passed, true);
    assert.equal(findCheck(res, "segments_nonempty")?.passed, false);
  });
});
