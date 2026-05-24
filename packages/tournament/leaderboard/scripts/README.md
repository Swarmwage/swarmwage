# Leaderboard scripts

## `generate-og.ts`

Regenerates `public/og.png` (1200x630, the social-share image referenced from
`public/index.html` via `<meta property="og:image">` and Twitter card meta).

### Run

```sh
# From the workspace root, with sharp installed:
pnpm tsx scripts/generate-og.ts

# Or via the package script (after `pnpm install` adds sharp):
pnpm --filter @swarmwage/tournament-leaderboard gen:og
```

### Notes

- The script composes an SVG in memory and rasterises via `sharp`. No
  external font files needed; system font stack rendered by librsvg inside
  sharp matches the leaderboard UI typography well enough for social unfurls.
- The generated PNG is checked into git so deploy doesn't need sharp at
  runtime. Re-run the script and commit the new PNG whenever the copy or
  brand changes.
- Output: ~78 KB, valid PNG, RGBA.
