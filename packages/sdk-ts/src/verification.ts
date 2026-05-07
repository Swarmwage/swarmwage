// Swarmwage Agent SDK — capability verification helpers
// One verification function per standard capability.
// License: MIT

import type { CapabilityId, VerificationResult } from "./types.js";

export type Verifier = (
  input: Record<string, unknown>,
  output: Record<string, unknown>,
) => VerificationResult;

/**
 * Built-in verifiers keyed by capability ID.
 *
 * v0.0.1 ships with a small set; the rest will be added incrementally.
 * Custom capabilities can register their own verifier via `registerVerifier`.
 */
const builtinVerifiers: Record<string, Verifier> = {
  "image.generate.photorealistic.png": (input, output) => {
    const checks = [
      check("output_has_image_b64", typeof output.image_b64 === "string"),
      check("image_b64_nonempty", isNonEmptyString(output.image_b64)),
      check(
        "dimensions_match",
        typeof output.width === "number" &&
          typeof output.height === "number" &&
          output.width === input.width &&
          output.height === input.height,
      ),
      check(
        "valid_image_magic",
        typeof output.image_b64 === "string" && isValidImageMagic(output.image_b64),
      ),
    ];
    return result(checks);
  },

  "code.execute.sandboxed": (input, output) => {
    const requested =
      typeof (input as { timeout_ms?: number }).timeout_ms === "number"
        ? (input as { timeout_ms?: number }).timeout_ms!
        : 5000;
    // Allow a 25% grace window for cleanup + IPC.
    const ceiling = Math.floor(requested * 1.25);
    const dur = (output as { duration_ms?: number }).duration_ms;
    const checks = [
      check("output_has_stdout", typeof output.stdout === "string"),
      check("output_has_stderr", typeof output.stderr === "string"),
      check(
        "exit_code_is_int",
        typeof output.exit_code === "number" && Number.isInteger(output.exit_code),
      ),
      check(
        "duration_within_timeout",
        typeof dur === "number" && dur >= 0 && dur <= ceiling,
      ),
      check("truncated_is_bool", typeof output.truncated === "boolean"),
    ];
    return result(checks);
  },

  "chart.generate.from-data": (input, output) => {
    const inData = (input as { data?: unknown[] }).data;
    const inType = (input as { chart_type?: string }).chart_type;
    const checks = [
      check(
        "input_data_nonempty",
        Array.isArray(inData) && inData.length > 0,
      ),
      check("output_has_image_b64", typeof output.image_b64 === "string"),
      check("image_b64_nonempty", isNonEmptyString(output.image_b64)),
      check(
        "dimensions_match",
        typeof output.width === "number" &&
          typeof output.height === "number" &&
          output.width === input.width &&
          output.height === input.height,
      ),
      check(
        "chart_type_match",
        typeof output.chart_type === "string" && output.chart_type === inType,
      ),
      check(
        "valid_png_magic",
        typeof output.image_b64 === "string" && isValidPng(output.image_b64),
      ),
    ];
    return result(checks);
  },

  "audio.transcribe.it.json-with-timestamps": (_input, output) => {
    const segs = output.segments;
    const checks = [
      check("output_is_object", typeof output === "object" && output !== null),
      check("segments_is_array", Array.isArray(segs)),
      check(
        "segments_nonempty",
        Array.isArray(segs) && segs.length > 0,
      ),
      check(
        "segments_monotonic_timestamps",
        Array.isArray(segs) && timestampsAreMonotonic(segs as TimestampedSegment[]),
      ),
    ];
    return result(checks);
  },

  "text.translate.en.it.business": (input, output) => {
    const inLen = wordCount(String((input as { text?: string }).text ?? ""));
    const outLen = wordCount(String((output as { text?: string }).text ?? ""));
    const ratio = inLen === 0 ? 0 : outLen / inLen;
    const checks = [
      check("output_text_nonempty", isNonEmptyString(output.text)),
      check("length_within_3x", ratio >= 0.3 && ratio <= 3),
    ];
    return result(checks);
  },
};

const customVerifiers: Record<string, Verifier> = {};

export function registerVerifier(capability: CapabilityId, verifier: Verifier): void {
  customVerifiers[capability] = verifier;
}

export function getVerifier(capability: CapabilityId): Verifier | null {
  return customVerifiers[capability] ?? builtinVerifiers[capability] ?? null;
}

export function verify(
  capability: CapabilityId,
  input: Record<string, unknown>,
  output: Record<string, unknown>,
): VerificationResult {
  const fn = getVerifier(capability);
  if (!fn) {
    return {
      checks: [{ name: "no_verifier_registered", passed: true }],
      all_passed: true,
    };
  }
  return fn(input, output);
}

// -------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------

function check(name: string, passed: boolean, detail?: string) {
  return { name, passed, detail };
}

function result(checks: { name: string; passed: boolean; detail?: string }[]) {
  return { checks, all_passed: checks.every((c) => c.passed) };
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

function wordCount(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

interface TimestampedSegment {
  start_ms?: number;
  end_ms?: number;
  text?: string;
}

function timestampsAreMonotonic(segs: TimestampedSegment[]): boolean {
  let last = -1;
  for (const s of segs) {
    if (typeof s.start_ms !== "number" || s.start_ms < last) return false;
    last = s.start_ms;
  }
  return true;
}

function decodeBase64Prefix(b64: string): string {
  // Decode just the first ~16 bytes to peek at the magic header
  const head = b64.slice(0, 24);
  try {
    if (typeof atob === "function") {
      return atob(head);
    }
    // Node fallback
    return Buffer.from(head, "base64").toString("binary");
  } catch {
    return "";
  }
}

function isValidImageMagic(b64: string): boolean {
  const prefix = decodeBase64Prefix(b64);
  // PNG: 89 50 4E 47
  if (prefix.startsWith("\x89PNG")) return true;
  // JPEG: FF D8 FF
  if (prefix.startsWith("\xff\xd8\xff")) return true;
  // WebP: RIFF....WEBP
  if (prefix.startsWith("RIFF") && prefix.slice(8, 12) === "WEBP") return true;
  // GIF
  if (prefix.startsWith("GIF87a") || prefix.startsWith("GIF89a")) return true;
  return false;
}

function isValidPng(b64: string): boolean {
  return decodeBase64Prefix(b64).startsWith("\x89PNG");
}
