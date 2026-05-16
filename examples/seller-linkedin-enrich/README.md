# @swarmwage/example-seller-linkedin-enrich

Reference seller for the `research.linkedin.profile.enrich` capability. Takes a public LinkedIn profile URL and returns a normalized profile object (name, headline, location, current position, company, summary, skills). Wraps the [Apify LinkedIn Profile Scraper actor](https://apify.com/apify/linkedin-profile-scraper) (`apify/linkedin-profile-scraper`).

This is a reference implementation under the `swarmwage-operated` seed cluster — fork it and run it with your own Apify token if you want to operate the same capability under your own wallet.

## Why this design

- **Apify** runs the actual scrape inside an actor that handles LinkedIn's bot defenses, proxy rotation, login pools, etc. We do not re-implement any of that.
- **Single backend, no fallback (v1)**. If Apify returns 5xx, times out, or returns an empty dataset, the seller responds 502 and the buyer is not charged.
- **Cost per hire**: $0.50 USDC per profile. Apify's actor charges roughly $0.01–0.05 per successful run on standard plans, leaving comfortable margin for the seller operator.

## Setup

```bash
pnpm install
```

## Run

```bash
SELLER_PRIVATE_KEY=0x...                      # 0x-prefixed 32-byte hex
APIFY_API_TOKEN=apify_api_...                 # Apify account token
PORT=4006                                     # default
REGISTRY_URL=http://localhost:3000            # canonical Swarmwage registry
PUBLIC_URL=http://localhost:4006              # what we publish to the registry
PRICE_USDC=0.50                               # default
NETWORK=base-sepolia                          # or base for mainnet
FACILITATOR_URL=https://x402.org/facilitator
APIFY_TIMEOUT_MS=90000                        # Apify run-sync timeout

pnpm start
```

Generate a wallet key with:

```bash
node -e 'import("viem/accounts").then(m=>console.log(m.generatePrivateKey()))'
```

Get an Apify token at <https://console.apify.com/settings/integrations>.

## Schema

Input:

```json
{
  "profile_url": "https://www.linkedin.com/in/satyanadella"
}
```

`profile_url` must match `https://(www.)?linkedin.com/in/<slug>` (regex enforced; non-LinkedIn URLs, `localhost`, `file://`, private IPs are all rejected before reaching Apify). Maximum length 256 chars.

Output (canonical):

```json
{
  "profile": {
    "url": "https://www.linkedin.com/in/satyanadella",
    "name": "Satya Nadella",
    "headline": "Chairman and CEO at Microsoft",
    "location": "Redmond, Washington, United States",
    "current_position": "Chairman and CEO",
    "company": "Microsoft",
    "summary": "...",
    "skills": ["Cloud Computing", "Artificial Intelligence", "..."],
    "source": "apify"
  }
}
```

Fields that Apify does not return for a given profile are set to `null` (with `skills` defaulting to `[]`). Provenance is pinned via `source: "apify"` so downstream consumers can audit where each profile came from.

## Verification checks

The seller runs the same verifier the buyer-side SDK runs, before returning the response. If any check fails, the seller returns 502 and the buyer is not charged.

| Check | What it asserts |
|---|---|
| `output_is_object` | top-level result is a plain object |
| `profile_is_object` | `profile` is a plain object |
| `profile_has_url` | `profile.url` is a non-empty string |
| `profile_has_name` | `profile.name` is a non-empty string |
| `source_is_apify` | `profile.source` equals `"apify"` (provenance pin) |

## Safety

- **Allowlist, not denylist** on `profile_url`: only `https://(www.)?linkedin.com/in/<slug>` is accepted. Everything else (other LinkedIn paths, other domains, `localhost`, `127.0.0.1`, `http://`, `file://`) is rejected BEFORE any upstream call. SSRF surface is minimal because Apify is the one fetching, but the allowlist still bounds what we will hand to Apify.
- URL length cap (256 chars) to prevent log/token abuse.
- 90 s default timeout per Apify call (`APIFY_TIMEOUT_MS`) — LinkedIn scrapes are slow.
- Per-IP rate limit (20 req/min/IP) and per-day budget cap (500 hires, $25 upstream spend) defend the Apify quota from flood attacks.

## Deploy

Single-container Docker image, build context = repo root:

```bash
docker build -f examples/seller-linkedin-enrich/Dockerfile -t swarmwage-linkedin-enrich .
docker run -p 4006:4006 \
  -e SELLER_PRIVATE_KEY=0x... \
  -e APIFY_API_TOKEN=apify_api_... \
  -e REGISTRY_URL=https://registry.swarmwage.com \
  -e PUBLIC_URL=https://linkedin-enrich.swarmwage.com \
  -e NETWORK=base \
  swarmwage-linkedin-enrich
```

## License

MIT — see top of every source file.
