// Reference Swarmwage seller — fulfills audio.transcribe.json-with-timestamps
// via Groq Whisper (primary) + fal.ai Whisper (fallback). Language-neutral.
// License: MIT
//
// Usage:
//   SELLER_PRIVATE_KEY=0x... GROQ_API_KEY=gsk_... PORT=4005 \
//     REGISTRY_URL=http://localhost:3010 \
//     pnpm --filter @swarmwage/example-seller-audio-transcribe start
//
// Backend pipeline:
//   1. validate input (audio_url, optional language_hint), SSRF-guard the URL
//   2. HEAD then streamed GET — enforce content-length + size cap
//   3. send to Groq whisper-large-v3 (response_format=verbose_json)
//   4. on 5xx / timeout / network → fall back to fal.ai whisper
//   5. normalize segments → { start_ms, end_ms, text } and language to
//      ISO 639-1 lowercase
//   6. run verifier mirror (output_is_object, language_iso_639_1,
//      segments_nonempty + monotonic) before responding

import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { keccak256, toBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { paymentMiddleware, type Network } from "x402-hono";
import { z } from "zod";
import {
  PROTOCOL_VERSION,
  submitReceipt,
  type AgentId,
  type Hex,
  type Listing,
} from "@swarmwage/agent-sdk";
import { clientIp, rateLimit, SlidingWindowLimiter } from "./rate-limit.js";
import { DailyBudget, dailyBudgetGuard } from "./daily-budget.js";
import { transcribe, TranscribeBackendError } from "./transcribe.js";
import { verifyTranscript } from "./verify.js";
import { firstCallFreeGate, inMemoryTracker } from "./first-call-free.js";

const PRIVATE_KEY = process.env.SELLER_PRIVATE_KEY as Hex | undefined;
if (!PRIVATE_KEY) {
  process.stderr.write(
    "seller-audio-transcribe: SELLER_PRIVATE_KEY required (0x-prefixed 32-byte hex)\n",
  );
  process.exit(1);
}

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const FAL_API_KEY = process.env.FAL_API_KEY;
if (!GROQ_API_KEY && !FAL_API_KEY) {
  process.stderr.write(
    "seller-audio-transcribe: at least one of GROQ_API_KEY or FAL_API_KEY required\n",
  );
  process.exit(1);
}

const PORT = Number(process.env.PORT ?? 4005);
const REGISTRY_URL = process.env.REGISTRY_URL ?? "http://localhost:3000";
const PUBLIC_URL = process.env.PUBLIC_URL ?? `http://localhost:${PORT}`;
const PRICE_USDC = process.env.PRICE_USDC ?? "0.10";
const NETWORK = (process.env.NETWORK ?? "base-sepolia") as Network;
const FACILITATOR_URL = (process.env.FACILITATOR_URL ??
  "https://x402.org/facilitator") as `${string}://${string}`;

// Per-IP rate limit on /hire. Tunable via env so an operator can tighten
// or loosen for a known-trusted deployment without rebuilding.
const HIRE_RATE_LIMIT_PER_IP = Number(
  process.env.HIRE_RATE_LIMIT_PER_IP ?? 20,
);
const HIRE_RATE_WINDOW_MS = Number(process.env.HIRE_RATE_WINDOW_MS ?? 60_000);
const hireIpLimiter = new SlidingWindowLimiter({
  limit: HIRE_RATE_LIMIT_PER_IP,
  windowMs: HIRE_RATE_WINDOW_MS,
});
setInterval(() => hireIpLimiter.gc(), HIRE_RATE_WINDOW_MS).unref();

// Per-day budget guard. Caps both hire count AND cumulative upstream USD,
// resetting at UTC midnight. Tunable via env so an operator can lift the
// ceiling for a known-trusted deployment without rebuilding.
const MAX_DAILY_HIRES = Number(process.env.MAX_DAILY_HIRES ?? 1000);
const MAX_DAILY_SPEND_USD = Number(process.env.MAX_DAILY_SPEND_USD ?? 50);
// Groq whisper-large-v3 free tier (~7200 calls/day): assume 0 cost on the
// happy path. The fal.ai fallback charges ~$0.06 per minute of audio, so
// 0.06 is the worst-case per-call estimate when fallback fires; treat the
// declared value as a conservative upper bound.
const EST_UPSTREAM_USD_PER_CALL = Number(
  process.env.EST_UPSTREAM_USD_PER_CALL ?? 0.06,
);
const dailyBudget = new DailyBudget({
  maxHires: MAX_DAILY_HIRES,
  maxSpendUsd: MAX_DAILY_SPEND_USD,
});

const GROQ_MODEL = process.env.GROQ_MODEL ?? "whisper-large-v3";
const FAL_MODEL = process.env.FAL_MODEL ?? "fal-ai/whisper";
const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS ?? 8_000);
const GROQ_TIMEOUT_MS = Number(process.env.GROQ_TIMEOUT_MS ?? 30_000);
const FAL_TIMEOUT_MS = Number(process.env.FAL_TIMEOUT_MS ?? 30_000);
const MAX_AUDIO_MB = Number(process.env.MAX_AUDIO_MB ?? 50);
const MAX_AUDIO_BYTES = Math.max(1, Math.floor(MAX_AUDIO_MB * 1024 * 1024));
const ALLOW_PRIVATE_FETCH = process.env.ALLOW_PRIVATE_FETCH === "1";

const account = privateKeyToAccount(PRIVATE_KEY);
const agentId = account.address.toLowerCase() as AgentId;

// -------------------------------------------------------------------------
// Input schema (zod)
// -------------------------------------------------------------------------

const HireParams = z.object({
  audio_url: z.string().url(),
  language_hint: z
    .string()
    .regex(/^[a-z]{2}$/, "language_hint must be ISO 639-1 lowercase (2 chars)")
    .optional(),
});

type HireParamsType = z.infer<typeof HireParams>;

// -------------------------------------------------------------------------
// Safe fetch — SSRF guard, size cap, timeout
// -------------------------------------------------------------------------

class FetchTooLarge extends Error {}
class UnsafeUrl extends Error {}

function assertSafeUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new UnsafeUrl("invalid URL");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new UnsafeUrl(`unsupported protocol: ${u.protocol}`);
  }
  if (ALLOW_PRIVATE_FETCH) return u;

  const host = u.hostname.toLowerCase();
  // Block obvious private/local addresses by hostname. Production-grade SSRF
  // protection would also resolve DNS and check the resolved IP, but for v0.1
  // the hostname check is enough.
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") {
    throw new UnsafeUrl("localhost not allowed");
  }
  if (
    host.startsWith("10.") ||
    host.startsWith("192.168.") ||
    host.startsWith("169.254.") ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  ) {
    throw new UnsafeUrl("private IP range not allowed");
  }
  return u;
}

interface FetchedAudio {
  bytes: Uint8Array;
  contentType: string;
  filename: string;
}

async function fetchAudio(rawUrl: string): Promise<FetchedAudio> {
  const u = assertSafeUrl(rawUrl);

  // Best-effort HEAD: cheap content-length check before paying download cost.
  try {
    const headController = new AbortController();
    const headTimer = setTimeout(
      () => headController.abort(),
      Math.min(FETCH_TIMEOUT_MS, 4_000),
    );
    let head: Response;
    try {
      head = await fetch(u.toString(), {
        method: "HEAD",
        signal: headController.signal,
        redirect: "follow",
        headers: {
          "User-Agent":
            "SwarmwageBot/0.1 (+https://swarmwage.com; audio.transcribe.json-with-timestamps)",
        },
      });
    } finally {
      clearTimeout(headTimer);
    }
    if (head.ok) {
      const lenStr = head.headers.get("content-length");
      if (lenStr) {
        const len = Number(lenStr);
        if (Number.isFinite(len) && len > MAX_AUDIO_BYTES) {
          throw new FetchTooLarge(
            `content-length ${len} exceeds limit ${MAX_AUDIO_BYTES}`,
          );
        }
      }
    }
  } catch (err) {
    if (err instanceof FetchTooLarge) throw err;
    // HEAD not supported, CORS-style errors, etc. — fall through to GET with
    // streaming size cap.
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(u.toString(), {
      method: "GET",
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "User-Agent":
          "SwarmwageBot/0.1 (+https://swarmwage.com; audio.transcribe.json-with-timestamps)",
        Accept: "audio/*,application/octet-stream;q=0.9,*/*;q=0.5",
      },
    });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    throw new Error(`fetch ${u.toString()} → HTTP ${res.status}`);
  }
  const contentType =
    res.headers.get("content-type")?.split(";")[0]?.trim() ||
    "application/octet-stream";

  const reader = res.body?.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (reader) {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > MAX_AUDIO_BYTES) {
          await reader.cancel();
          throw new FetchTooLarge(
            `audio exceeded ${MAX_AUDIO_BYTES} bytes (got ${total})`,
          );
        }
        chunks.push(value);
      }
    }
  } else {
    const ab = await res.arrayBuffer();
    if (ab.byteLength > MAX_AUDIO_BYTES) {
      throw new FetchTooLarge(
        `audio exceeded ${MAX_AUDIO_BYTES} bytes (got ${ab.byteLength})`,
      );
    }
    chunks.push(new Uint8Array(ab));
    total = ab.byteLength;
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.byteLength;
  }

  // Derive a filename for multipart upload from the URL path's last segment.
  let filename = "audio";
  try {
    const last = u.pathname.split("/").filter(Boolean).pop();
    if (last && last.includes(".")) filename = last;
  } catch {
    // ignore
  }

  return { bytes: merged, contentType, filename };
}

// -------------------------------------------------------------------------
// End-to-end pipeline
// -------------------------------------------------------------------------

async function runTranscription(input: HireParamsType) {
  const fetched = await fetchAudio(input.audio_url);
  const result = await transcribe({
    audio: fetched.bytes,
    filename: fetched.filename,
    contentType: fetched.contentType,
    language_hint: input.language_hint,
    groqApiKey: GROQ_API_KEY,
    groqModel: GROQ_MODEL,
    groqTimeoutMs: GROQ_TIMEOUT_MS,
    falApiKey: FAL_API_KEY,
    falModel: FAL_MODEL,
    falTimeoutMs: FAL_TIMEOUT_MS,
  });
  return result;
}

// -------------------------------------------------------------------------
// Sign + publish listing
// -------------------------------------------------------------------------

async function signTypedPayload(payload: object): Promise<Hex> {
  const canonical = JSON.stringify(payload, Object.keys(payload).sort());
  const hash = keccak256(toBytes(canonical));
  return account.signMessage({ message: { raw: hash } });
}

async function publishListing(): Promise<void> {
  const listingPayload = {
    agent_id: agentId,
    capability: "audio.transcribe.json-with-timestamps",
    price_usdc: PRICE_USDC,
    currency: "USDC" as const,
    chain: "base" as const,
    max_latency_ms: 30_000,
    first_call_free: true,
    endpoint: PUBLIC_URL,
  };
  const signature = await signTypedPayload(listingPayload);
  const listing: Listing = { ...listingPayload, signature };

  const res = await fetch(`${REGISTRY_URL}/v1/listings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(listing),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Failed to publish listing: ${res.status} ${txt}`);
  }
  process.stderr.write(
    `seller-audio-transcribe: listing published (capability=${listingPayload.capability}, price=${PRICE_USDC} USDC)\n`,
  );
}

// -------------------------------------------------------------------------
// HTTP server
// -------------------------------------------------------------------------

type Variables = {
  pendingReceipt?: {
    payload: Parameters<typeof submitReceipt>[0]["payload"];
  };
  freeCall?: boolean;
  freeCallBuyerId?: string;
};
const firstCallTracker = inMemoryTracker();
const app = new Hono<{ Variables: Variables }>();

app.get("/", (c) =>
  c.json({
    name: "swarmwage seller — audio.transcribe.json-with-timestamps",
    agent_id: agentId,
    protocol: PROTOCOL_VERSION,
    backend: GROQ_API_KEY
      ? `groq:${GROQ_MODEL}${FAL_API_KEY ? ` (fallback: ${FAL_MODEL})` : ""}`
      : `fal:${FAL_MODEL}`,
    network: NETWORK,
    price_usdc: PRICE_USDC,
    max_audio_mb: MAX_AUDIO_MB,
  }),
);

// Per-IP flood guard. Mounted BEFORE paymentMiddleware so a flood attack
// is rejected with 429 without ever invoking the facilitator.
app.use("/hire", rateLimit(hireIpLimiter, clientIp));

// Per-day budget guard — closes /hire with 503 once the day's hire count or
// upstream spend cap is hit. Mounted before paymentMiddleware so the buyer
// is never charged USDC for a call we cannot fulfil.
app.use("/hire", dailyBudgetGuard(dailyBudget, EST_UPSTREAM_USD_PER_CALL));

// Receipt-submission post-hook. Mounted BEFORE paymentMiddleware so its
// post-await(next) phase runs AFTER paymentMiddleware has attached the
// X-PAYMENT-RESPONSE header (which carries the real settlement tx_hash).
// The /hire handler stashes the receipt payload via c.set("pendingReceipt").
app.use("/hire", async (c, next) => {
  await next();
  const pending = c.get("pendingReceipt") as
    | { payload: Parameters<typeof submitReceipt>[0]["payload"] }
    | undefined;
  if (!pending) return;
  if (c.res.status >= 400) return;
  let txHash =
    "0x0000000000000000000000000000000000000000000000000000000000000000";
  const paymentResponseHeader = c.res.headers.get("X-PAYMENT-RESPONSE");
  if (paymentResponseHeader) {
    try {
      const decoded = JSON.parse(
        Buffer.from(paymentResponseHeader, "base64").toString("utf8"),
      ) as { transaction?: string; txHash?: string };
      txHash = decoded.transaction ?? decoded.txHash ?? txHash;
    } catch {
      // header malformed — keep placeholder
    }
  }
  void submitReceipt({
    registryUrl: REGISTRY_URL,
    sellerPrivateKey: PRIVATE_KEY,
    payload: { ...pending.payload, tx_hash: txHash as `0x${string}` },
  });
});

// Wrapped by `firstCallFreeGate` so a buyer's first-ever hire against this
// seller bypasses payment (SPEC §11 — listing advertises first_call_free).
const pmw = paymentMiddleware(
  account.address,
  {
    "POST /hire": {
      price: `$${PRICE_USDC}`,
      network: NETWORK,
    },
  },
  { url: FACILITATOR_URL },
);

app.use(
  "/hire",
  firstCallFreeGate({ paymentMiddleware: pmw, tracker: firstCallTracker }),
);

app.post("/hire", async (c) => {
  const t0 = Date.now();
  const body = (await c.req.json()) as {
    protocol?: string;
    buyer_id?: AgentId;
    capability?: string;
    params?: unknown;
    max_price_usdc?: string;
    nonce?: string;
  };

  if (body.protocol !== PROTOCOL_VERSION) {
    return c.json(
      { error: `Unsupported protocol: ${body.protocol ?? "?"}` },
      400,
    );
  }
  if (body.capability !== "audio.transcribe.json-with-timestamps") {
    return c.json(
      { error: `Capability not supported: ${body.capability}` },
      400,
    );
  }

  const parsed = HireParams.safeParse(body.params);
  if (!parsed.success) {
    return c.json(
      {
        error: "params validation failed",
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      },
      400,
    );
  }

  let result: Awaited<ReturnType<typeof runTranscription>>;
  try {
    result = await runTranscription(parsed.data);
  } catch (err) {
    if (err instanceof UnsafeUrl) {
      return c.json({ error: `Refused URL: ${err.message}` }, 400);
    }
    if (err instanceof FetchTooLarge) {
      return c.json({ error: err.message }, 413);
    }
    if (err instanceof TranscribeBackendError) {
      process.stderr.write(
        `seller-audio-transcribe: backend failure (${err.stage}) — ${err.message}\n`,
      );
      return c.json(
        { error: `Transcription failed: ${err.message}`, stage: err.stage },
        502,
      );
    }
    process.stderr.write(
      `seller-audio-transcribe: transcription failed — ${(err as Error).message}\n`,
    );
    return c.json(
      { error: `Transcription failed: ${(err as Error).message}` },
      502,
    );
  }

  const transcript = result.transcript;
  const verification = verifyTranscript({
    language: transcript.language,
    segments: transcript.segments,
  });
  if (!verification.all_passed) {
    process.stderr.write(
      `seller-audio-transcribe: verifier rejected output — ${JSON.stringify(verification.checks)}\n`,
    );
    return c.json(
      {
        error: "Backend output failed local verification",
        verification,
      },
      502,
    );
  }

  const completedAt = Math.floor(Date.now() / 1000);
  const latency = Date.now() - t0;
  const receiptId = `rcpt_${crypto.randomUUID()}`;
  const ratingToken = `rtt_${crypto.randomUUID()}`;
  const freeCall = c.get("freeCall") === true;
  const pricePaid = freeCall ? "0.00" : PRICE_USDC;

  // Commit free-call consumption only after a successful transcription +
  // verification pass.
  if (freeCall) {
    const buyerKey = c.get("freeCallBuyerId");
    if (buyerKey) firstCallTracker.markSeen(buyerKey);
  }

  // x402-hono attaches X-PAYMENT-RESPONSE on the response only AFTER this
  // handler returns. We ship tx_hash=0x0…0 here and the @swarmwage/agent-sdk
  // client patches it from the response header on its side. The signed
  // receipt is submitted by the post-hook middleware mounted above.
  const ZERO_HASH =
    "0x0000000000000000000000000000000000000000000000000000000000000000";

  // Stash the receipt payload (without tx_hash) for the post-hook to pick up
  // and submit once X-PAYMENT-RESPONSE is attached to the response.
  c.set("pendingReceipt", {
    payload: {
      protocol_version: PROTOCOL_VERSION,
      hire_id: receiptId,
      agent_id: agentId,
      buyer:
        (body.buyer_id?.toLowerCase() as AgentId) ??
        ("0x0000000000000000000000000000000000000000" as AgentId),
      capability: body.capability ?? "audio.transcribe.json-with-timestamps",
      amount_usdc_atomic: freeCall ? "0" : priceUsdcToAtomic(PRICE_USDC),
      network: NETWORK as "base" | "base-sepolia",
      tx_hash: ZERO_HASH as `0x${string}`,
      completed_at: new Date(completedAt * 1000).toISOString(),
      verification: {
        all_passed: verification.all_passed,
        checks: Object.fromEntries(
          verification.checks.map((c) => [c.name, c.passed]),
        ),
      },
    },
  });

  return c.json({
    protocol: PROTOCOL_VERSION,
    receipt: {
      receipt_id: receiptId,
      buyer_id: body.buyer_id ?? "0x0000000000000000000000000000000000000000",
      seller_id: agentId,
      capability: body.capability,
      tx_hash: ZERO_HASH,
      price_paid_usdc: pricePaid,
      completed_at: completedAt,
      first_call_free: freeCall,
    },
    result: {
      language: transcript.language,
      segments: transcript.segments,
    },
    verification,
    rating_token: ratingToken,
    _meta: {
      backend_used: result.meta.backend_used,
      duration_ms: result.meta.duration_ms,
      audio_size_bytes: result.meta.audio_size_bytes,
      latency_ms: latency,
      first_call_free: freeCall,
    },
  });
});

// Convert "0.10" → "100000" (USDC has 6 decimals).
function priceUsdcToAtomic(price: string): string {
  const [intPart, fracPart = ""] = price.split(".");
  const frac = (fracPart + "000000").slice(0, 6);
  const combined = `${intPart}${frac}`.replace(/^0+(?=\d)/, "");
  return combined === "" ? "0" : combined;
}

// -------------------------------------------------------------------------
// Boot
// -------------------------------------------------------------------------

(async () => {
  try {
    await publishListing();
  } catch (err) {
    process.stderr.write(
      `seller-audio-transcribe: WARN failed to publish listing — ${(err as Error).message}\n`,
    );
  }

  serve({ fetch: app.fetch, port: PORT }, () => {
    process.stderr.write(
      `seller-audio-transcribe v0.0.1 listening on ${PUBLIC_URL} (agent_id=${agentId})\n`,
    );
  });
})();
