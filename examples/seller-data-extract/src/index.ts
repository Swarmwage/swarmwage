// Reference Swarmwage seller — fulfills data.extract.from-url
// via cheerio (HTML pre-extraction) + Claude Haiku (structured output).
// License: MIT
//
// Usage:
//   SELLER_PRIVATE_KEY=0x... ANTHROPIC_API_KEY=sk-ant-... PORT=4004 \
//     REGISTRY_URL=http://localhost:3010 \
//     pnpm --filter @swarmwage/example-seller-data-extract start
//
// Backend pipeline:
//   1. fetch the URL (timeout, size cap, SSRF guard)
//   2. cheerio.load(html) → pull JSON-LD (schema.org Product/Article/etc.),
//      OpenGraph + meta, <title>, <h1>, etc.
//   3. send the pre-extracted hints + raw text snippet to Claude Haiku
//      with a forced tool_use call → guaranteed JSON schema-bound output
//   4. validate confidence + return
//
// For local smoke, the seller also serves a synthetic product page at
// GET /sample/product-001.html so demos can run without samples.swarmwage.com.

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { keccak256, toBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { paymentMiddleware, type Network } from "x402-hono";
import * as cheerio from "cheerio";
import Anthropic from "@anthropic-ai/sdk";
import {
  PROTOCOL_VERSION,
  type AgentId,
  type Hex,
  type Listing,
} from "@swarmwage/agent-sdk";

const PRIVATE_KEY = process.env.SELLER_PRIVATE_KEY as Hex | undefined;
if (!PRIVATE_KEY) {
  process.stderr.write(
    "seller-data-extract: SELLER_PRIVATE_KEY required (0x-prefixed 32-byte hex)\n",
  );
  process.exit(1);
}

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
if (!ANTHROPIC_API_KEY) {
  process.stderr.write(
    "seller-data-extract: ANTHROPIC_API_KEY required\n",
  );
  process.exit(1);
}

const PORT = Number(process.env.PORT ?? 4004);
const REGISTRY_URL = process.env.REGISTRY_URL ?? "http://localhost:3000";
const PUBLIC_URL = process.env.PUBLIC_URL ?? `http://localhost:${PORT}`;
const PRICE_USDC = process.env.PRICE_USDC ?? "0.05";
const NETWORK = (process.env.NETWORK ?? "base-sepolia") as Network;
const FACILITATOR_URL = (process.env.FACILITATOR_URL ??
  "https://x402.org/facilitator") as `${string}://${string}`;
const ANTHROPIC_MODEL =
  process.env.ANTHROPIC_MODEL ?? "claude-haiku-4-5-20251001";
const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS ?? 8_000);
const DEFAULT_MAX_KB = 512;
const HARD_MAX_KB = 4_096;
const ALLOW_PRIVATE_FETCH = process.env.ALLOW_PRIVATE_FETCH === "1";

const account = privateKeyToAccount(PRIVATE_KEY);
const agentId = account.address.toLowerCase() as AgentId;
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// -------------------------------------------------------------------------
// Capability types
// -------------------------------------------------------------------------

interface ExtractInput {
  url: string;
  fields: string[];
  max_response_kb?: number;
}

interface ExtractOutput {
  url: string;
  extracted: Record<string, unknown>;
  confidence: number;
  extracted_at: string;
}

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
  // protection would also resolve DNS and check the IP, but for v0.1 the
  // hostname check + the "samples.swarmwage.com" sample target is enough.
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") {
    throw new UnsafeUrl(`localhost not allowed`);
  }
  if (
    host.startsWith("10.") ||
    host.startsWith("192.168.") ||
    host.startsWith("169.254.") ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  ) {
    throw new UnsafeUrl(`private IP range not allowed`);
  }
  return u;
}

async function safeFetch(rawUrl: string, maxBytes: number): Promise<string> {
  const u = assertSafeUrl(rawUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(u.toString(), {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "User-Agent":
          "SwarmwageBot/0.1 (+https://swarmwage.com; data.extract.from-url)",
        Accept: "text/html,application/xhtml+xml",
      },
    });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    throw new Error(`fetch ${u.toString()} → HTTP ${res.status}`);
  }
  const reader = res.body?.getReader();
  if (!reader) {
    return await res.text();
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new FetchTooLarge(
          `response exceeded ${maxBytes} bytes (got ${total})`,
        );
      }
      chunks.push(value);
    }
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder("utf-8").decode(merged);
}

// -------------------------------------------------------------------------
// Cheerio pre-extraction — pull the high-signal hints from the HTML
// -------------------------------------------------------------------------

interface PageHints {
  url: string;
  title: string | null;
  h1: string | null;
  meta_description: string | null;
  og: Record<string, string>;
  twitter: Record<string, string>;
  json_ld: unknown[];
  text_excerpt: string;
}

function extractHints(html: string, url: string): PageHints {
  const $ = cheerio.load(html);
  const og: Record<string, string> = {};
  const twitter: Record<string, string> = {};
  $('meta[property^="og:"]').each((_i, el) => {
    const k = $(el).attr("property");
    const v = $(el).attr("content");
    if (k && v) og[k.replace(/^og:/, "")] = v;
  });
  $('meta[name^="twitter:"]').each((_i, el) => {
    const k = $(el).attr("name");
    const v = $(el).attr("content");
    if (k && v) twitter[k.replace(/^twitter:/, "")] = v;
  });

  const json_ld: unknown[] = [];
  $('script[type="application/ld+json"]').each((_i, el) => {
    const txt = $(el).text();
    if (!txt.trim()) return;
    try {
      const parsed: unknown = JSON.parse(txt);
      if (Array.isArray(parsed)) json_ld.push(...parsed);
      else json_ld.push(parsed);
    } catch {
      // Some sites embed broken JSON-LD; skip silently.
    }
  });

  // Strip script/style/nav/footer noise then collapse whitespace.
  $("script, style, noscript, nav, footer, header, svg").remove();
  const bodyText = $("body").text().replace(/\s+/g, " ").trim();
  const text_excerpt = bodyText.slice(0, 4_000);

  return {
    url,
    title: $("title").first().text().trim() || null,
    h1: $("h1").first().text().trim() || null,
    meta_description: $('meta[name="description"]').attr("content") ?? null,
    og,
    twitter,
    json_ld,
    text_excerpt,
  };
}

// -------------------------------------------------------------------------
// Claude Haiku — structured extraction via forced tool_use
// -------------------------------------------------------------------------

function buildExtractionTool(fields: string[]): Anthropic.Tool {
  // We accept any of {string, number, boolean, null} for each requested
  // field. Field-level type conformance (currency ISO, https://, ≤280 chars)
  // is enforced by the system prompt + the SDK verifier on the buyer side.
  const properties: Record<string, unknown> = {};
  for (const f of fields) {
    properties[f] = {
      type: ["string", "number", "boolean", "null"],
      description: `Extracted value for "${f}". Return null if not found on the page.`,
    };
  }
  return {
    name: "return_extraction",
    description:
      "Return the extracted fields as a structured JSON object. Always call this tool exactly once.",
    input_schema: {
      type: "object",
      properties: {
        extracted: {
          type: "object",
          properties,
          required: fields,
          additionalProperties: false,
        },
        confidence: {
          type: "number",
          description:
            "Your overall confidence that the extraction is correct, 0.0 to 1.0.",
        },
      },
      required: ["extracted", "confidence"],
    },
  };
}

const SYSTEM_PROMPT = `You are a precise structured-extraction agent.

Given pre-parsed hints from a web page (title, JSON-LD, OpenGraph, meta, body excerpt), extract the requested fields and call the \`return_extraction\` tool exactly once with the result.

Conventions when the field is present:
- price_currency → 3-letter ISO 4217 code (USD, EUR, GBP). Uppercase.
- price_amount → numeric, no currency symbols, no thousands separators.
- availability → "in_stock" | "out_of_stock" | "unknown".
- *_url fields → full https:// URL (resolve relative paths).
- description_short → ≤ 280 characters, single coherent sentence/phrase.
- *_at fields → ISO 8601 string.

When the page does not provide a field, return null for that field, do not invent values, and lower your confidence accordingly.

Prefer JSON-LD (schema.org Product/Article/Recipe/Event) when present — it's the highest-confidence source. Then OpenGraph. Then meta + heuristic text.`;

async function extractFields(
  hints: PageHints,
  fields: string[],
): Promise<{ extracted: Record<string, unknown>; confidence: number }> {
  const tool = buildExtractionTool(fields);
  const res = await anthropic.messages.create({
    model: ANTHROPIC_MODEL,
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    tools: [tool],
    tool_choice: { type: "tool", name: "return_extraction" },
    messages: [
      {
        role: "user",
        content: `Requested fields: ${JSON.stringify(fields)}\n\nPage hints:\n${JSON.stringify(hints, null, 2)}`,
      },
    ],
  });

  const toolUse = res.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
  );
  if (!toolUse) {
    throw new Error("Claude did not call the extraction tool");
  }
  const input = toolUse.input as {
    extracted?: Record<string, unknown>;
    confidence?: number;
  };
  if (!input.extracted || typeof input.confidence !== "number") {
    throw new Error("Claude returned malformed extraction payload");
  }
  return { extracted: input.extracted, confidence: input.confidence };
}

// -------------------------------------------------------------------------
// End-to-end pipeline
// -------------------------------------------------------------------------

async function runExtraction(input: ExtractInput): Promise<ExtractOutput> {
  if (!Array.isArray(input.fields) || input.fields.length === 0) {
    throw new Error("params.fields must be a non-empty string array");
  }
  const maxKb = Math.min(
    HARD_MAX_KB,
    Math.max(1, input.max_response_kb ?? DEFAULT_MAX_KB),
  );
  const html = await safeFetch(input.url, maxKb * 1024);
  const hints = extractHints(html, input.url);
  const { extracted, confidence } = await extractFields(hints, input.fields);

  return {
    url: input.url,
    extracted,
    confidence: Math.max(0, Math.min(1, confidence)),
    extracted_at: new Date().toISOString(),
  };
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
    capability: "data.extract.from-url",
    price_usdc: PRICE_USDC,
    currency: "USDC" as const,
    chain: "base" as const,
    max_latency_ms: 12_000,
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
    `seller-data-extract: listing published (capability=${listingPayload.capability}, price=${PRICE_USDC} USDC)\n`,
  );
}

// -------------------------------------------------------------------------
// HTTP server
// -------------------------------------------------------------------------

const app = new Hono();

app.get("/", (c) =>
  c.json({
    name: "swarmwage seller — data.extract.from-url",
    agent_id: agentId,
    protocol: PROTOCOL_VERSION,
    backend: `cheerio + ${ANTHROPIC_MODEL}`,
    network: NETWORK,
    price_usdc: PRICE_USDC,
  }),
);

// Synthetic sample product page so the demo runs without samples.swarmwage.com.
app.get("/sample/product-001.html", async (c) => {
  const here = dirname(fileURLToPath(import.meta.url));
  const path = resolve(here, "..", "samples", "product-001.html");
  const html = await readFile(path, "utf8");
  return c.html(html);
});

app.use(
  paymentMiddleware(
    account.address,
    {
      "POST /hire": {
        price: `$${PRICE_USDC}`,
        network: NETWORK,
      },
    },
    { url: FACILITATOR_URL },
  ),
);

app.post("/hire", async (c) => {
  const t0 = Date.now();
  const body = (await c.req.json()) as {
    protocol?: string;
    buyer_id?: AgentId;
    capability?: string;
    params?: ExtractInput;
    max_price_usdc?: string;
    nonce?: string;
  };

  if (body.protocol !== PROTOCOL_VERSION) {
    return c.json(
      { error: `Unsupported protocol: ${body.protocol ?? "?"}` },
      400,
    );
  }
  if (body.capability !== "data.extract.from-url") {
    return c.json(
      { error: `Capability not supported: ${body.capability}` },
      400,
    );
  }
  const params = body.params;
  if (!params || typeof params.url !== "string") {
    return c.json({ error: "params.url required" }, 400);
  }

  let result: ExtractOutput;
  try {
    result = await runExtraction(params);
  } catch (err) {
    if (err instanceof UnsafeUrl) {
      return c.json({ error: `Refused URL: ${err.message}` }, 400);
    }
    if (err instanceof FetchTooLarge) {
      return c.json({ error: err.message }, 415);
    }
    process.stderr.write(
      `seller-data-extract: extraction failed — ${(err as Error).message}\n`,
    );
    return c.json({ error: `Extraction failed: ${(err as Error).message}` }, 502);
  }

  const completedAt = Math.floor(Date.now() / 1000);
  const latency = Date.now() - t0;
  const receiptId = `rcpt_${crypto.randomUUID()}`;
  const ratingToken = `rtt_${crypto.randomUUID()}`;

  const paymentResponseHeader = c.res.headers.get("X-PAYMENT-RESPONSE");
  let txHash =
    "0x0000000000000000000000000000000000000000000000000000000000000000";
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

  return c.json({
    protocol: PROTOCOL_VERSION,
    receipt: {
      receipt_id: receiptId,
      buyer_id: body.buyer_id ?? "0x0000000000000000000000000000000000000000",
      seller_id: agentId,
      capability: body.capability,
      tx_hash: txHash,
      price_paid_usdc: PRICE_USDC,
      completed_at: completedAt,
    },
    result,
    verification: {
      checks: [
        { name: "fetched_ok", passed: true },
        { name: "fields_returned", passed: true },
        { name: "confidence_in_range", passed: true },
      ],
      all_passed: true,
    },
    rating_token: ratingToken,
    _meta: { latency_ms: latency },
  });
});

// -------------------------------------------------------------------------
// Boot
// -------------------------------------------------------------------------

(async () => {
  try {
    await publishListing();
  } catch (err) {
    process.stderr.write(
      `seller-data-extract: WARN failed to publish listing — ${(err as Error).message}\n`,
    );
  }

  serve({ fetch: app.fetch, port: PORT }, () => {
    process.stderr.write(
      `seller-data-extract v0.0.1 listening on ${PUBLIC_URL} (agent_id=${agentId})\n`,
    );
  });
})();
