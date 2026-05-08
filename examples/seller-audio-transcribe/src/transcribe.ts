// Swarmwage seller-audio-transcribe — backend transcription logic.
// License: MIT
//
// Two-tier backend: Groq Whisper (primary, free tier generous) with
// fal.ai Whisper as fallback. The seller stays language-neutral —
// language is detected by Whisper and returned as ISO 639-1 lowercase.

export interface CanonicalSegment {
  start_ms: number;
  end_ms: number;
  text: string;
}

export interface CanonicalTranscript {
  language: string; // ISO 639-1 lowercase
  segments: CanonicalSegment[];
}

export interface TranscribeMeta {
  backend_used: "groq" | "fal";
  duration_ms: number;
  audio_size_bytes: number;
}

export interface TranscribeResult {
  transcript: CanonicalTranscript;
  meta: TranscribeMeta;
}

export interface TranscribeOptions {
  audio: Uint8Array;
  filename: string;
  contentType: string;
  language_hint?: string;
  groqApiKey: string | undefined;
  groqModel: string;
  groqTimeoutMs: number;
  falApiKey: string | undefined;
  falModel: string;
  falTimeoutMs: number;
}

export class TranscribeBackendError extends Error {
  readonly stage: "groq" | "fal" | "all";
  constructor(stage: "groq" | "fal" | "all", message: string) {
    super(message);
    this.stage = stage;
  }
}

// -------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------

function toMs(seconds: number | string | undefined): number {
  const n = typeof seconds === "string" ? Number(seconds) : (seconds ?? 0);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.round(n * 1000);
}

function normalizeLanguage(raw: unknown): string {
  if (typeof raw !== "string" || raw.length === 0) return "und";
  const lower = raw.toLowerCase().trim();
  // Whisper sometimes returns full language names ("italian"). Best-effort
  // mapping for the common cases; otherwise fall back to first 2 chars if
  // they look like a valid ISO 639-1 code.
  const NAMES: Record<string, string> = {
    italian: "it",
    english: "en",
    spanish: "es",
    french: "fr",
    german: "de",
    portuguese: "pt",
    dutch: "nl",
    russian: "ru",
    chinese: "zh",
    japanese: "ja",
    korean: "ko",
    arabic: "ar",
    turkish: "tr",
    polish: "pl",
    swedish: "sv",
    norwegian: "no",
    danish: "da",
    finnish: "fi",
    czech: "cs",
    greek: "el",
    hebrew: "he",
    hindi: "hi",
    ukrainian: "uk",
    romanian: "ro",
    hungarian: "hu",
  };
  if (NAMES[lower]) return NAMES[lower]!;
  if (/^[a-z]{2}$/.test(lower)) return lower;
  if (/^[a-z]{2}-[a-z]{2}$/.test(lower)) return lower.slice(0, 2);
  return "und";
}

interface RawSegment {
  start?: number | string;
  end?: number | string;
  text?: string;
}

function normalizeSegments(raw: unknown, fallbackText: string): CanonicalSegment[] {
  if (Array.isArray(raw)) {
    const out: CanonicalSegment[] = [];
    for (const s of raw as RawSegment[]) {
      const text = typeof s.text === "string" ? s.text.trim() : "";
      if (!text) continue;
      const start_ms = toMs(s.start);
      const end_ms = toMs(s.end);
      out.push({
        start_ms,
        end_ms: end_ms > start_ms ? end_ms : start_ms,
        text,
      });
    }
    if (out.length > 0) return out;
  }
  // Fallback: synthesize a single segment from the full text so we never
  // return an empty segments[] (verifier requires non-empty).
  const t = fallbackText.trim();
  if (!t) return [];
  return [{ start_ms: 0, end_ms: 0, text: t }];
}

function inferAudioFilename(contentType: string, fallback: string): string {
  const ct = contentType.toLowerCase();
  if (ct.includes("mpeg") || ct.includes("mp3")) return "audio.mp3";
  if (ct.includes("mp4") || ct.includes("m4a")) return "audio.m4a";
  if (ct.includes("wav")) return "audio.wav";
  if (ct.includes("webm")) return "audio.webm";
  if (ct.includes("ogg")) return "audio.ogg";
  if (ct.includes("flac")) return "audio.flac";
  return fallback;
}

// -------------------------------------------------------------------------
// Groq — primary backend
// -------------------------------------------------------------------------

interface GroqResponse {
  text?: string;
  language?: string;
  segments?: RawSegment[];
}

async function callGroq(opts: TranscribeOptions): Promise<CanonicalTranscript> {
  if (!opts.groqApiKey) {
    throw new TranscribeBackendError("groq", "GROQ_API_KEY not configured");
  }
  const filename = inferAudioFilename(opts.contentType, opts.filename);
  const form = new FormData();
  form.append(
    "file",
    new Blob([opts.audio as BlobPart], { type: opts.contentType || "application/octet-stream" }),
    filename,
  );
  form.append("model", opts.groqModel);
  form.append("response_format", "verbose_json");
  if (opts.language_hint) {
    form.append("language", opts.language_hint);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.groqTimeoutMs);
  let res: Response;
  try {
    res = await fetch(
      "https://api.groq.com/openai/v1/audio/transcriptions",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${opts.groqApiKey}` },
        body: form,
        signal: controller.signal,
      },
    );
  } catch (err) {
    throw new TranscribeBackendError(
      "groq",
      `Groq fetch failed: ${(err as Error).message}`,
    );
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new TranscribeBackendError(
      "groq",
      `Groq returned HTTP ${res.status}: ${txt.slice(0, 300)}`,
    );
  }
  const data = (await res.json()) as GroqResponse;
  const fullText = typeof data.text === "string" ? data.text : "";
  return {
    language: normalizeLanguage(data.language ?? opts.language_hint),
    segments: normalizeSegments(data.segments, fullText),
  };
}

// -------------------------------------------------------------------------
// fal.ai — fallback backend
// -------------------------------------------------------------------------
//
// fal.ai Whisper queue API expects a JSON body with `audio_url`. To stay
// HTTP-only we upload the audio bytes via fal.ai storage first, get back a
// URL, then submit. For the v0.1 fallback we go a simpler route: post the
// audio as a data URL inline. fal.ai accepts both. If the data URL is too
// large (>~10 MB after base64 expansion), this path fails — that's
// acceptable for a fallback.

interface FalChunk {
  start?: number | string;
  end?: number | string;
  text?: string;
  timestamp?: [number, number] | undefined;
}

interface FalResponse {
  text?: string;
  language?: string;
  chunks?: FalChunk[];
}

async function callFal(opts: TranscribeOptions): Promise<CanonicalTranscript> {
  if (!opts.falApiKey) {
    throw new TranscribeBackendError("fal", "FAL_API_KEY not configured");
  }
  const b64 = Buffer.from(opts.audio).toString("base64");
  const dataUrl = `data:${opts.contentType || "audio/mpeg"};base64,${b64}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.falTimeoutMs);
  let res: Response;
  try {
    res = await fetch(`https://fal.run/${opts.falModel}`, {
      method: "POST",
      headers: {
        Authorization: `Key ${opts.falApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        audio_url: dataUrl,
        task: "transcribe",
        chunk_level: "segment",
        language: opts.language_hint ?? null,
      }),
      signal: controller.signal,
    });
  } catch (err) {
    throw new TranscribeBackendError(
      "fal",
      `fal.ai fetch failed: ${(err as Error).message}`,
    );
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new TranscribeBackendError(
      "fal",
      `fal.ai returned HTTP ${res.status}: ${txt.slice(0, 300)}`,
    );
  }
  const data = (await res.json()) as FalResponse;
  const fullText = typeof data.text === "string" ? data.text : "";
  // fal.ai's whisper endpoints emit `chunks` rather than `segments`. Map.
  const rawChunks: RawSegment[] = (data.chunks ?? []).map((c) => {
    if (Array.isArray(c.timestamp) && c.timestamp.length === 2) {
      return { start: c.timestamp[0], end: c.timestamp[1], text: c.text };
    }
    return { start: c.start, end: c.end, text: c.text };
  });
  return {
    language: normalizeLanguage(data.language ?? opts.language_hint),
    segments: normalizeSegments(rawChunks, fullText),
  };
}

// -------------------------------------------------------------------------
// Public entry point — try Groq, fall back to fal.ai
// -------------------------------------------------------------------------

export async function transcribe(opts: TranscribeOptions): Promise<TranscribeResult> {
  const t0 = Date.now();
  const errors: string[] = [];

  // Primary
  if (opts.groqApiKey) {
    try {
      const transcript = await callGroq(opts);
      return {
        transcript,
        meta: {
          backend_used: "groq",
          duration_ms: Date.now() - t0,
          audio_size_bytes: opts.audio.byteLength,
        },
      };
    } catch (err) {
      errors.push(`groq: ${(err as Error).message}`);
    }
  } else {
    errors.push("groq: GROQ_API_KEY not configured");
  }

  // Fallback
  if (opts.falApiKey) {
    try {
      const transcript = await callFal(opts);
      return {
        transcript,
        meta: {
          backend_used: "fal",
          duration_ms: Date.now() - t0,
          audio_size_bytes: opts.audio.byteLength,
        },
      };
    } catch (err) {
      errors.push(`fal: ${(err as Error).message}`);
    }
  } else {
    errors.push("fal: FAL_API_KEY not configured");
  }

  throw new TranscribeBackendError(
    "all",
    `All transcription backends failed — ${errors.join(" | ")}`,
  );
}
