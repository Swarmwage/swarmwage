// Swarmwage seller-audio-transcribe — server-side verification mirror.
// License: MIT
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
  language: unknown;
  segments: unknown;
}

export interface VerifyResult {
  checks: VerificationCheckResult[];
  all_passed: boolean;
}

const ISO_639_1 = /^[a-z]{2}$/;

export function verifyTranscript(out: VerifyOutput): VerifyResult {
  const checks: VerificationCheckResult[] = [];

  // 1. output_is_object — top-level shape
  const isObject =
    out !== null && typeof out === "object" && !Array.isArray(out);
  checks.push({ name: "output_is_object", passed: isObject });

  // 2. language_iso_639_1 — 2-char lowercase code
  const language = (out as { language?: unknown }).language;
  const langOk =
    typeof language === "string" && ISO_639_1.test(language);
  checks.push({
    name: "language_iso_639_1",
    passed: langOk,
    detail: langOk ? undefined : `got: ${typeof language === "string" ? language : typeof language}`,
  });

  // 3. segments_is_array
  const segments = (out as { segments?: unknown }).segments;
  const isArray = Array.isArray(segments);
  checks.push({ name: "segments_is_array", passed: isArray });

  // 4. segments_nonempty
  const nonEmpty = isArray && (segments as unknown[]).length > 0;
  checks.push({ name: "segments_nonempty", passed: nonEmpty });

  // 5. segments_monotonic — start_ms <= end_ms within each segment, and
  //    each segment starts at or after the previous one ends.
  let monotonic = true;
  let monotonicDetail: string | undefined;
  if (isArray && nonEmpty) {
    const segs = segments as Array<{
      start_ms?: unknown;
      end_ms?: unknown;
      text?: unknown;
    }>;
    let prevEnd = 0;
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i]!;
      const start = typeof s.start_ms === "number" ? s.start_ms : NaN;
      const end = typeof s.end_ms === "number" ? s.end_ms : NaN;
      const text = typeof s.text === "string" ? s.text : "";
      if (
        !Number.isFinite(start) ||
        !Number.isFinite(end) ||
        start < 0 ||
        end < start ||
        text.length === 0
      ) {
        monotonic = false;
        monotonicDetail = `segment ${i} malformed (start=${start}, end=${end}, text_len=${text.length})`;
        break;
      }
      if (start < prevEnd - 50) {
        // Allow tiny overlaps (≤50 ms) — Whisper sometimes does this at
        // segment boundaries. Larger overlap = real ordering bug.
        monotonic = false;
        monotonicDetail = `segment ${i} starts ${prevEnd - start}ms before previous end`;
        break;
      }
      prevEnd = end;
    }
  } else {
    monotonic = false;
    monotonicDetail = "skipped — segments missing or empty";
  }
  checks.push({
    name: "segments_monotonic",
    passed: monotonic,
    detail: monotonicDetail,
  });

  return {
    checks,
    all_passed: checks.every((c) => c.passed),
  };
}
