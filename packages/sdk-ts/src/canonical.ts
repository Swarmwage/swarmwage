// Swarmwage Agent SDK — deterministic canonical JSON for signing
// License: MIT
//
// Recursive, deterministic serialization of a signed payload: object keys are
// sorted at EVERY level (so nested fields like `verification.all_passed` are
// covered by the signature), compact separators, and an enforced value domain.
// Replaces the old `JSON.stringify(payload, Object.keys(payload).sort())` whose
// array replacer silently dropped nested keys. Byte-identical to the Python
// SDK's `canonical_typed_payload`.

export class CanonicalizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanonicalizationError";
  }
}

/**
 * Canonical JSON string for the Swarmwage signing scheme (an RFC 8785 / JCS
 * subset). Allowed value domain: string, finite integer, boolean, null, array,
 * plain object (ASCII keys). Throws {@link CanonicalizationError} on anything
 * else — float, NaN, Infinity, undefined, bigint, symbol, function, Date or any
 * other non-plain object — so a disallowed value can never silently change the
 * signed bytes.
 */
export function canonicalize(value: unknown): string {
  return enc(value);
}

// An unpaired UTF-16 surrogate: a lone high (not followed by a low) or a lone
// low (not preceded by a high). TS `JSON.stringify` escapes these to `\udXXX`,
// but Python's `str.encode("utf-8")` raises on them — so they would break
// TS↔Python parity. Reject in both. Well-formed surrogate PAIRS (astral chars)
// pass and are byte-identical across both SDKs.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function enc(v: unknown): string {
  if (v === null) return "null";
  switch (typeof v) {
    case "string":
      if (LONE_SURROGATE.test(v)) {
        throw new CanonicalizationError("lone surrogate in string value not allowed");
      }
      return JSON.stringify(v);
    case "boolean":
      return v ? "true" : "false";
    case "number":
      if (!Number.isInteger(v)) {
        throw new CanonicalizationError(`non-integer number not allowed: ${v}`);
      }
      // A float64 silently rounds integers above 2^53-1, so TS would sign
      // different bytes than Python's exact int. Reject — keeps TS↔Python parity.
      if (!Number.isSafeInteger(v)) {
        throw new CanonicalizationError(`integer out of safe (±2^53-1) range: ${v}`);
      }
      return String(v);
    case "object": {
      if (Array.isArray(v)) {
        const items: string[] = [];
        for (let i = 0; i < v.length; i++) {
          // `Array.prototype.map` skips holes; reject sparse arrays explicitly
          // (Python has no equivalent, so a hole would diverge the signed bytes).
          if (!(i in v)) {
            throw new CanonicalizationError(`sparse array hole at index ${i} not allowed`);
          }
          items.push(enc(v[i]));
        }
        return "[" + items.join(",") + "]";
      }
      if (!isPlainObject(v)) {
        throw new CanonicalizationError(
          `only plain objects allowed, got ${Object.prototype.toString.call(v)}`,
        );
      }
      const obj = v as Record<string, unknown>;
      const keys = Object.keys(obj);
      // Enforce ASCII keys BEFORE sorting: JS sorts by UTF-16 code unit, Python
      // by code point, which diverge for astral keys. All protocol keys are ASCII.
      for (const k of keys) {
        if (!/^[\x00-\x7f]*$/.test(k)) {
          throw new CanonicalizationError(`non-ASCII object key not allowed: ${JSON.stringify(k)}`);
        }
      }
      const parts: string[] = [];
      for (const k of keys.sort()) {
        const val = obj[k];
        if (val === undefined) {
          throw new CanonicalizationError(`undefined value at key "${k}" not allowed`);
        }
        parts.push(JSON.stringify(k) + ":" + enc(val));
      }
      return "{" + parts.join(",") + "}";
    }
    default:
      // undefined, bigint, symbol, function
      throw new CanonicalizationError(`unsupported value type: ${typeof v}`);
  }
}

function isPlainObject(v: object): boolean {
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}
