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

  "data.extract.from-url": (input, output) => {
    const requestedFields = (input as { fields?: unknown }).fields;
    const extracted = (output as { extracted?: unknown }).extracted;
    const isObj = typeof extracted === "object" && extracted !== null && !Array.isArray(extracted);
    const fieldsArr = Array.isArray(requestedFields)
      ? (requestedFields as unknown[]).filter((x): x is string => typeof x === "string")
      : [];
    const ext = isObj ? (extracted as Record<string, unknown>) : {};

    const allFieldsPresent =
      isObj && fieldsArr.length > 0 && fieldsArr.every((f) => f in ext);

    // Field-level conventions: only validate when the field is non-null.
    // Sellers may return null for fields they couldn't extract.
    const currency = ext.price_currency;
    const currencyOk =
      currency === undefined ||
      currency === null ||
      (typeof currency === "string" && /^[A-Z]{3}$/.test(currency));

    const price = ext.price_amount;
    const priceOk =
      price === undefined ||
      price === null ||
      (typeof price === "number" && Number.isFinite(price) && price >= 0);

    const avail = ext.availability;
    const availOk =
      avail === undefined ||
      avail === null ||
      avail === "in_stock" ||
      avail === "out_of_stock" ||
      avail === "unknown";

    const urlFieldsOk = Object.entries(ext).every(([k, v]) => {
      if (!k.endsWith("_url")) return true;
      if (v === null) return true;
      return typeof v === "string" && /^https:\/\/[^\s]+$/.test(v);
    });

    const descShort = ext.description_short;
    const descOk =
      descShort === undefined ||
      descShort === null ||
      (typeof descShort === "string" && descShort.length <= 280);

    const conf = (output as { confidence?: unknown }).confidence;
    const confOk = typeof conf === "number" && conf >= 0 && conf <= 1;

    const extractedAt = (output as { extracted_at?: unknown }).extracted_at;
    const extractedAtOk =
      typeof extractedAt === "string" && !Number.isNaN(Date.parse(extractedAt));

    const checks = [
      check("output_extracted_is_object", isObj),
      check("requested_fields_present", allFieldsPresent),
      check("price_currency_iso_4217", currencyOk),
      check("price_amount_nonnegative", priceOk),
      check("availability_in_enum", availOk),
      check("url_fields_https", urlFieldsOk),
      check("description_short_within_280", descOk),
      check("confidence_in_range", confOk),
      check("extracted_at_iso_8601", extractedAtOk),
    ];
    return result(checks);
  },

  "audio.transcribe.json-with-timestamps": (_input, output) => {
    const segs = output.segments;
    const lang = (output as { language?: unknown }).language;
    const checks = [
      check("output_is_object", typeof output === "object" && output !== null),
      check(
        "language_is_iso_639_1",
        typeof lang === "string" && /^[a-z]{2}$/.test(lang),
      ),
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
