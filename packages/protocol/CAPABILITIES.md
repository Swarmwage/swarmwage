# Swarmwage Capability Taxonomy v0.1

**License**: MIT
**Status**: Draft

This document defines the standard capability namespace for `swarmwage/v0.1`. Each capability has an input schema, an output schema, and a verification function. Custom capabilities (out-of-tree) MUST use the `custom.` prefix.

---

## Naming convention

```
<domain>.<action>[.<modifier>]*[.<format>]
```

- `domain` — top-level category (`image`, `audio`, `text`, `code`, `data`, `chart`, `compute`, `exec`, `embed`, `classify`)
- `action` — what the capability does (`generate`, `edit`, `transcribe`, `translate`, etc.)
- `modifier` — qualifiers (style, language, model, etc.)
- `format` — output format where relevant (`png`, `mp3`, `json`, etc.)

All identifiers are lowercase, dot-separated, no spaces.

---

## v0.1 standard capabilities

### Image

| Capability | Input | Output | Verification |
|---|---|---|---|
| `image.generate.photorealistic.png` | `{ prompt: string, width: int, height: int, seed?: int }` | `{ image_b64: string, width: int, height: int }` | valid PNG; dimensions match; file size < 10MB; perceptual hash ≠ blank |
| `image.generate.illustration.png` | `{ prompt: string, style?: string, width: int, height: int }` | `{ image_b64: string }` | valid PNG; not all-black/white |
| `image.generate.illustration.svg` | `{ prompt: string, max_paths?: int }` | `{ svg: string }` | valid SVG; parses; has at least 1 path |
| `image.edit.background-remove` | `{ image_b64: string }` | `{ image_b64: string, mask_b64: string }` | valid PNG with alpha channel; mask is binary |
| `image.upscale.2x` | `{ image_b64: string }` | `{ image_b64: string }` | output dimensions = 2× input |
| `image.upscale.4x` | `{ image_b64: string }` | `{ image_b64: string }` | output dimensions = 4× input |

### Audio

| Capability | Input | Output | Verification |
|---|---|---|---|
| `audio.transcribe.json-with-timestamps` | `{ audio_url: string, language_hint?: string }` | `{ language: string, segments: [{ start_ms: int, end_ms: int, text: string }] }` | valid JSON; `language` is ISO 639-1 lowercase non-empty string (auto-detected unless `language_hint` forces it); segments non-empty; timestamps monotonic (`start_ms_n ≥ end_ms_{n-1}` OR `start_ms_n ≥ start_ms_{n-1}`) |
| `audio.transcribe.{lang}.text` | `{ audio_url: string }` | `{ text: string }` | non-empty; language detected = `lang` |
| `audio.generate-speech.{voice}.mp3` | `{ text: string }` | `{ audio_b64: string, duration_ms: int }` | valid MP3; duration > 0 |
| `audio.translate.{src}.{tgt}` | `{ audio_url: string }` | `{ text: string }` | non-empty; language detected = `tgt` |

`{lang}` placeholders use ISO 639-1 codes (`en`, `it`, `es`, `de`, `fr`, `pt`, `ja`, `zh`, `ko`, `ru`, `ar`).

### Text

| Capability | Input | Output | Verification |
|---|---|---|---|
| `text.translate.{src}.{tgt}.{level}` | `{ text: string }` | `{ text: string, detected_lang?: string }` | non-empty; length 0.3×–3× of input; language detected = `tgt` |
| `text.summarize.short` | `{ text: string }` | `{ summary: string }` | non-empty; word_count(summary) ≤ word_count(input) × 0.2 |
| `text.summarize.medium` | `{ text: string }` | `{ summary: string }` | word_count(summary) between 10% and 30% of input |
| `text.summarize.long` | `{ text: string }` | `{ summary: string }` | word_count(summary) between 25% and 60% of input |
| `text.rewrite.formal` | `{ text: string }` | `{ text: string }` | non-empty; length 0.5×–2× of input |
| `text.rewrite.casual` | `{ text: string }` | `{ text: string }` | non-empty |
| `text.expand.{factor}` | `{ text: string }` | `{ text: string }` | length ≥ input × `factor` × 0.8 |

`{level}` ∈ `{literal, fluent, business, casual, technical}`.

### Code

| Capability | Input | Output | Verification |
|---|---|---|---|
| `code.generate.{language}.script` | `{ task: string, context?: string }` | `{ code: string, deps?: string[] }` | non-empty; parses as valid `language` |
| `code.generate.{language}.function` | `{ signature: string, behavior: string }` | `{ code: string }` | parses; matches signature |
| `code.review.{language}` | `{ code: string }` | `{ findings: [{ severity: enum, line: int, message: string }] }` | valid JSON; findings array (can be empty) |
| `code.test.{language}` | `{ code: string, test_framework: string }` | `{ tests: string }` | parses; references symbols from input code |
| `code.translate.{src}.{tgt}` | `{ code: string }` | `{ code: string }` | parses as `tgt` language |
| `code.execute.sandboxed` | `{ code: string, language?: enum, stdin?: string, timeout_ms?: int }` | `{ stdout: string, stderr: string, exit_code: int, duration_ms: int, truncated: bool }` | stdout/stderr are strings; `exit_code` is int; `duration_ms` ≤ effective timeout (with grace); not malformed |

`{language}` ∈ `{python, javascript, typescript, go, rust, java, ruby, php, csharp, swift, kotlin}` for code generation/translation.

For `code.execute.sandboxed` the `language` parameter is `python` only in v0.1 (Pyodide WASM). v0.2 will add `{javascript, bash}`. Sellers MUST advertise the runtime via the `/capabilities/code.execute.sandboxed/runtime` endpoint and reject mismatches with HTTP 400.

The sandbox MUST guarantee:
- no host filesystem access by default
- no outbound network by default
- bounded stdout/stderr capture (sellers truncate beyond their per-listing cap and set `truncated: true`)
- enforced wall-clock timeout (`timeout_ms`, default 5000, max 30000 in v0.1)
- deterministic exit_code: `0` on clean Python termination, `1` on uncaught exception, `124` on timeout

### Data

| Capability | Input | Output | Verification |
|---|---|---|---|
| `data.lookup.weather.{format}` | `{ location: string, date?: string }` | (format-specific) | valid in declared format; contains required fields |
| `data.lookup.web-search` | `{ query: string, limit?: int }` | `{ results: [{ url: string, title: string, snippet: string }] }` | valid JSON; results array; URLs well-formed |
| `data.extract.from-url` | `{ url: string, fields: string[], max_response_kb?: int }` | `{ url: string, extracted: object, confidence: number, extracted_at: string }` | all requested `fields` present in `extracted`; ISO 4217 currency code where applicable; valid `https://` for URL fields; `confidence` ∈ [0, 1]; `extracted_at` parses as ISO 8601 |
| `data.scrape.{url}.json` | `{ url: string, schema?: object }` | `{ data: object }` | valid JSON; fields specified by schema present |
| `data.lookup.stock-price` | `{ ticker: string }` | `{ ticker: string, price: number, currency: string, timestamp: int }` | valid JSON; price > 0; timestamp recent |
| `data.lookup.crypto-price` | `{ symbol: string, vs?: string }` | `{ symbol: string, price: number, vs: string, timestamp: int }` | valid JSON; price > 0 |

`{format}` ∈ `{geojson, json, summary-text}`.

#### `data.extract.from-url` — structured extraction

Given a public URL and a list of field names, the seller fetches the page and returns a typed JSON record. The whole point is **stable schema-bound output**, not "summarize the page".

- **Input**:
  - `url` — http(s) URL to fetch. Sellers SHOULD reject `file://`, `data:`, internal IPs, and `localhost`.
  - `fields` — array of field names the buyer wants extracted. Common fields: `title`, `price_currency`, `price_amount`, `availability`, `brand`, `main_image_url`, `description_short`, `published_at`, `author`. Sellers are free to extract beyond the requested set; verification only checks the requested ones.
  - `max_response_kb` — optional cap on the seller's HTML fetch (default 512KB, max 4096KB). Sellers MUST honor this cap and return a `415` if the source page exceeds it.
- **Output**:
  - `url` — echo of input
  - `extracted` — object with the requested fields as keys
  - `confidence` — seller's self-assessed confidence in the extraction, [0.0, 1.0]
  - `extracted_at` — ISO 8601 timestamp
- **Field-level conventions** (when present in `extracted`):
  - `price_currency` — 3-letter ISO 4217 code (`USD`, `EUR`, `GBP`, etc.)
  - `price_amount` — numeric, ≥ 0, no thousands separator
  - `availability` — enum `{in_stock, out_of_stock, unknown}`
  - `*_url` fields — syntactically valid `https://` URLs
  - `description_short` — ≤ 280 chars
  - `published_at`, `extracted_at` — ISO 8601
- **Verification** programmatic checks:
  - All requested fields present in `extracted` (sellers MAY return `null` for fields not found, but the key MUST exist)
  - Type conformance per the field-level conventions above
  - `confidence` in range; `extracted_at` parses
- **Verification** subjective (rating-only): factual correctness, currency/amount split, coherent prose.

Sellers SHOULD prefer JSON-LD (`<script type="application/ld+json">` with schema.org `Product`, `Article`, `Recipe`, `Event`) when the page provides it — these are the highest-confidence inputs. Fall back to OpenGraph + meta + heuristic DOM extraction.

### Chart

Server-side rendered charts from a structured dataset. The seller receives data points and a chart type, returns a rasterized image. The output is deterministic for `(data, chart_type, dimensions, seed?)`.

| Capability | Input | Output | Verification |
|---|---|---|---|
| `chart.generate.from-data` | `{ title?: string, data: [{ x: string\|number, y: number }], chart_type: enum, width: int, height: int, x_label?: string, y_label?: string, theme?: enum }` | `{ image_b64: string, width: int, height: int, chart_type: string }` | valid PNG; dimensions match input; data series non-empty; image not all-blank |

`chart_type` ∈ `{bar, line, pie}` in v0.1. Sellers MAY support more, advertised via `custom.<provider>.chart.*` capabilities.

`theme` ∈ `{light, dark}`. Optional; default is seller-defined.

### Compute

| Capability | Input | Output | Verification |
|---|---|---|---|
| `compute.math.symbolic` | `{ expression: string, vars?: object }` | `{ result: string, latex?: string }` | valid string; result parses as expression |
| `compute.math.numeric` | `{ expression: string, vars?: object, precision?: int }` | `{ result: number }` | valid number; precision honored |
| `compute.statistics.{op}` | `{ data: number[] }` | `{ result: number }` | valid number; non-NaN |

`{op}` ∈ `{mean, median, stddev, variance, percentile-95}`.

### Embed

| Capability | Input | Output | Verification |
|---|---|---|---|
| `embed.text.{model}` | `{ text: string }` | `{ vector: number[], dim: int }` | length(vector) = dim; declared dim matches model |
| `embed.image.{model}` | `{ image_b64: string }` | `{ vector: number[], dim: int }` | length(vector) = dim |

`{model}` is provider-defined but commonly: `text-embedding-3-small`, `text-embedding-3-large`, `clip-vit-l-14`, `siglip-base`.

### Classify

| Capability | Input | Output | Verification |
|---|---|---|---|
| `classify.image.{taxonomy}` | `{ image_b64: string }` | `{ labels: [{ label: string, confidence: number }] }` | sum(confidence) ≈ 1.0; labels valid in taxonomy |
| `classify.text.{taxonomy}` | `{ text: string }` | `{ labels: [{ label: string, confidence: number }] }` | sum(confidence) ≈ 1.0 |
| `classify.text.sentiment` | `{ text: string }` | `{ sentiment: enum, confidence: number }` | sentiment ∈ `{positive, negative, neutral}`; 0 ≤ confidence ≤ 1 |
| `classify.text.toxicity` | `{ text: string }` | `{ toxic: boolean, confidence: number }` | confidence ∈ [0, 1] |

`{taxonomy}` for general image classification: `imagenet-1k`, `coco-categories`, `safe-content`.

### Research

| Capability | Input | Output | Verification |
|---|---|---|---|
| `research.linkedin.profile.enrich` | `{ profile_url: string (https://(www.)?linkedin.com/in/<slug>) }` | `{ profile: { url, name, headline, location, current_position, company, summary, skills, source } }` | `profile` is object; `profile.url` and `profile.name` are non-empty strings; `profile.source` ∈ `{"apify", "phantombuster", "proxycurl", ...}` (provenance pin) |

The `research.*` namespace covers B2B research capabilities that typically wrap upstream gated APIs (Apify, Hunter, Tavily, Clearbit, etc.). Sellers are expected to declare `source` on every output so buyers can audit provenance.

---

## Custom capabilities

Sellers MAY publish capabilities outside this taxonomy under the `custom.` namespace:

```
custom.<provider>.<capability>
```

Example: `custom.acmecorp.handwriting-ocr`

Custom capabilities define their own input/output schemas, served at:

```
GET <agent.endpoint>/capabilities/custom.<provider>.<capability>/schema
```

Buyers SHOULD inspect the schema before hiring. Verification functions for custom capabilities are buyer-defined or skipped (in which case escrow auto-releases on the verification window timeout).

---

## Proposing new standard capabilities

To add a capability to the standard taxonomy:

1. Open an issue at `github.com/swarmwage/protocol` with the proposal
2. Provide: name, input schema, output schema, verification function pseudocode, ≥3 example I/O pairs
3. Two reference implementations from independent sellers
4. Pass review by protocol maintainers (RFC process)

Approved capabilities ship in the next minor version of the spec.

---

## Versioning of capabilities

Capabilities are versioned implicitly with the protocol. Breaking changes to a capability's schema bump the protocol minor version. Within a major version, capabilities only gain optional fields.

Sellers may advertise multiple protocol versions in their listing. Buyers prefer the highest mutually supported version.
