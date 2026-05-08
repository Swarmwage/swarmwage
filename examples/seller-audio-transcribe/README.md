# @swarmwage/example-seller-audio-transcribe

Reference seller for the `audio.transcribe.json-with-timestamps` capability. Downloads an audio file from a public URL, transcribes it with Whisper, and returns word-level segments with millisecond timestamps. Language is auto-detected and returned as an ISO 639-1 lowercase code (e.g. `it`, `en`, `es`) — the capability is language-neutral.

## Why this design

- **Whisper-large-v3** on Groq is the cheapest production-grade speech-to-text in 2026: free tier covers most early development, paid is ~$0.04/hour-of-audio.
- **fal.ai** is a drop-in fallback. The seller tries Groq first; on 5xx, timeout or network error it falls back to fal.ai. If both are unavailable, the request is rejected with 502 — the buyer is never charged for a failed delivery (verifier mirror runs before the response is returned).
- **Cost per hire**: the seller charges $0.10 USDC for audio up to ~10 minutes. Backend cost is well under $0.01 for typical voicenotes (1–3 minutes), leaving comfortable margin.

## Setup

```bash
pnpm install
```

## Run

```bash
SELLER_PRIVATE_KEY=0x...                    # 0x-prefixed 32-byte hex
GROQ_API_KEY=gsk_...                        # primary backend
FAL_API_KEY=...                             # optional fallback
PORT=4005                                   # default
REGISTRY_URL=http://localhost:3010          # canonical Swarmwage registry
PUBLIC_URL=http://localhost:4005            # what we publish to the registry
PRICE_USDC=0.10                             # default
NETWORK=base-sepolia                        # or base for mainnet
FACILITATOR_URL=https://x402.org/facilitator
GROQ_MODEL=whisper-large-v3
FAL_MODEL=fal-ai/whisper
FETCH_TIMEOUT_MS=8000                       # source audio download timeout
GROQ_TIMEOUT_MS=30000
FAL_TIMEOUT_MS=30000
MAX_AUDIO_MB=50                             # hard ceiling on source audio
ALLOW_PRIVATE_FETCH=0                       # set 1 to permit localhost (dev only)

pnpm start
```

Generate a key with:

```bash
node -e 'import("viem/accounts").then(m=>console.log(m.generatePrivateKey()))'
```

## Sample target

The reference sample (`it-voicenote-001.m4a`, ~90 s) is hosted on `samples.swarmwage.com` rather than committed to the repo (audio binary kept out of git). See [`samples/README.md`](./samples/README.md) for the asset spec; you can substitute any publicly-reachable audio URL when running the buyer demo.

```bash
CAPABILITY=audio.transcribe.json-with-timestamps \
  AUDIO_URL=https://samples.swarmwage.com/audio/it-voicenote-001.m4a \
  LANGUAGE_HINT=it \
  pnpm --filter @swarmwage/example-demo-buyer start
```

## Schema

See [`packages/protocol/CAPABILITIES.md`](../../packages/protocol/CAPABILITIES.md#audiotranscribejson-with-timestamps--language-neutral-speech-to-text).

Input:

```json
{
  "audio_url": "https://samples.swarmwage.com/audio/it-voicenote-001.m4a",
  "language_hint": "it"
}
```

`language_hint` is optional. When omitted, Whisper auto-detects the language. When present it must be a 2-character ISO 639-1 lowercase code; it improves accuracy on short clips.

Output (canonical):

```json
{
  "language": "it",
  "segments": [
    { "start_ms": 0, "end_ms": 3120, "text": "Ciao, sto registrando un memo vocale di prova." },
    { "start_ms": 3120, "end_ms": 7480, "text": "L'idea è che l'audio venga trascritto con i timestamp." }
  ]
}
```

## Verification checks

The seller runs the same verifier the buyer-side SDK runs, before returning the response. If any check fails, the seller returns 502 and the buyer is not charged.

| Check | What it asserts |
|---|---|
| `output_is_object` | top-level result is a plain object |
| `language_iso_639_1` | `language` is a 2-char lowercase string |
| `segments_is_array` | `segments` is an array |
| `segments_nonempty` | at least one segment is present |
| `segments_monotonic` | each segment has `start_ms ≤ end_ms`, `text` is non-empty, and segments don't overlap by more than 50 ms |

## Safety

- SSRF guard rejects `localhost`, `127.0.0.1`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16`. Override with `ALLOW_PRIVATE_FETCH=1` in dev only.
- Audio size cap (`MAX_AUDIO_MB`, default 50 MB) enforced via `Content-Length` HEAD check and a streaming reader on GET.
- 8 s default fetch timeout for the source URL (`FETCH_TIMEOUT_MS`).
- 30 s default timeout per backend call (`GROQ_TIMEOUT_MS`, `FAL_TIMEOUT_MS`).
- User-Agent identifies the bot: `SwarmwageBot/0.1 (+https://swarmwage.com; audio.transcribe.json-with-timestamps)`.

## Deploy

Single-container Docker image, build context = repo root:

```bash
docker build -f examples/seller-audio-transcribe/Dockerfile -t swarmwage-audio-transcribe .
docker run -p 4005:4005 \
  -e SELLER_PRIVATE_KEY=0x... \
  -e GROQ_API_KEY=gsk_... \
  -e REGISTRY_URL=https://registry.swarmwage.com \
  -e PUBLIC_URL=https://audio-transcribe.swarmwage.com \
  -e NETWORK=base \
  swarmwage-audio-transcribe
```

Fly.io:

```bash
fly secrets set SELLER_PRIVATE_KEY=0x... GROQ_API_KEY=gsk_... NETWORK=base PRICE_USDC=0.10
fly deploy
```

## License

MIT — see top of every source file.
