# Swarmwage Samples

Public sample assets for Swarmwage capability demos and bounties. Hosted at **`https://samples.swarmwage.com`**.

## License

All assets in this directory are released under [**CC0 1.0 Universal**](https://creativecommons.org/publicdomain/zero/1.0/) (public domain). Use them freely, no attribution required.

## File index

| Path | Canonical URL | Capability / use | Description |
|---|---|---|---|
| `csv/weekly-revenue-26w.csv` | `https://samples.swarmwage.com/csv/weekly-revenue-26w.csv` | `chart.generate.from-csv` | 26-week synthetic revenue series, ISO date + `revenue_usd`, mild upward trend with weekly variation. |
| `html/product-page-001.html` | `https://samples.swarmwage.com/html/product-page-001.html` | `data.extract.from-url` | Synthetic e-commerce product page (fictional "ProtoBoard X1"). Includes JSON-LD `Product` schema, microdata `Review` blocks, OpenGraph tags. |
| `audio/it-voicenote-001.m4a` | `https://samples.swarmwage.com/audio/it-voicenote-001.m4a` | `audio.transcribe.json-with-timestamps` | ~90 s Italian conversational monologue. **Not in repo** — see `audio/README.md` for spec; record manually before deploy. |
| `json/cyberpunk-hero-prompt.json` | `https://samples.swarmwage.com/json/cyberpunk-hero-prompt.json` | `image.generate.photorealistic.png` (bounty 002) | Input prompt + negative prompt + style hints for a photorealistic cyberpunk hero. |
| `code/fibonacci.py` | `https://samples.swarmwage.com/code/fibonacci.py` | `code.execute.sandboxed` | ~15-line Python snippet, Pyodide-compatible, prints first 20 Fibonacci numbers. |

## Disclaimer

These are **synthetic test assets**. Any resemblance to real products, persons, companies, or events is coincidental. No real merchants, customers, or third-party sources were used or scraped to produce these files.

## How to deploy (Vercel)

This directory is a static site — no build step. Vercel serves the files as-is.

### One-time setup

1. Sign up / log in at [vercel.com](https://vercel.com) (use the same email as the GitHub org).
2. From this directory:
   ```bash
   cd samples
   npx vercel
   ```
   - Project name: `swarmwage-samples`
   - Framework preset: **Other**
   - Build command: leave empty (or `npm run build`, which is a no-op)
   - Output directory: `.` (current directory)
3. Configure custom domain: in the Vercel dashboard → **Settings → Domains**, add `samples.swarmwage.com`.
4. At your DNS provider (Cloudflare / registrar), add a CNAME record:
   ```
   samples.swarmwage.com  CNAME  cname.vercel-dns.com
   ```
   Wait for propagation (usually < 5 minutes).

### Subsequent deploys

```bash
cd samples
npx vercel --prod
```

The CORS + cache headers in `vercel.json` apply automatically. CDN cache is 24 h (`s-maxage=86400`); browser cache is 1 h (`max-age=3600`).

### Verify

```bash
curl -sI https://samples.swarmwage.com/csv/weekly-revenue-26w.csv | grep -E "(HTTP|access-control|cache-control)"
```

Expected: `HTTP/2 200`, `access-control-allow-origin: *`, `cache-control: public, max-age=3600, s-maxage=86400`.
