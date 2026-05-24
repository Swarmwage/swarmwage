// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Swarmwage
//
// Generate `public/og.png` (1200x630) for social share unfurls.
//
// Run:  pnpm --filter @swarmwage/tournament-leaderboard gen:og
// or:   pnpm tsx scripts/generate-og.ts
//
// Output: packages/tournament/leaderboard/public/og.png

import sharp from 'sharp';
import { resolve, dirname } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const OUT_DIR = resolve(__dirname, '..', 'public');
const OUT_PATH = resolve(OUT_DIR, 'og.png');

const WIDTH = 1200;
const HEIGHT = 630;

// SVG composed as a string. Dark gradient bg, white text. No emojis.
const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#0a0e27"/>
      <stop offset="100%" stop-color="#1a1f3f"/>
    </linearGradient>
    <linearGradient id="accent" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="#5b7cff"/>
      <stop offset="100%" stop-color="#2954ff"/>
    </linearGradient>
  </defs>
  <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#bg)"/>

  <!-- subtle node-graph hint, top-right -->
  <g opacity="0.18" stroke="#5b7cff" stroke-width="1.5" fill="none">
    <circle cx="980" cy="120" r="6" fill="#5b7cff"/>
    <circle cx="1080" cy="180" r="6" fill="#5b7cff"/>
    <circle cx="1020" cy="260" r="6" fill="#5b7cff"/>
    <circle cx="1120" cy="320" r="6" fill="#5b7cff"/>
    <circle cx="940" cy="220" r="6" fill="#5b7cff"/>
    <line x1="980" y1="120" x2="1080" y2="180"/>
    <line x1="1080" y1="180" x2="1020" y2="260"/>
    <line x1="1020" y1="260" x2="1120" y2="320"/>
    <line x1="980" y1="120" x2="940" y2="220"/>
    <line x1="940" y1="220" x2="1020" y2="260"/>
  </g>

  <!-- accent rule -->
  <rect x="80" y="160" width="80" height="4" fill="url(#accent)"/>

  <!-- title -->
  <text x="80" y="260" font-family="Inter, system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
        font-size="84" font-weight="700" fill="#ffffff" letter-spacing="-2">
    Swarmwage Tournament
  </text>

  <!-- subtitle -->
  <text x="80" y="340" font-family="Inter, system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
        font-size="38" font-weight="500" fill="#dfe4ff" letter-spacing="-0.5">
    10 LLMs &#xb7; 24h &#xb7; real USDC on Base
  </text>

  <!-- supporting line -->
  <text x="80" y="400" font-family="Inter, system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
        font-size="26" font-weight="400" fill="#9aa3d4">
    Live agent-to-agent commerce on the Swarmwage protocol.
  </text>

  <!-- footer URL -->
  <text x="80" y="565" font-family="Inter, system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
        font-size="22" font-weight="500" fill="rgba(255,255,255,0.5)" letter-spacing="0.5">
    tournament.swarmwage.com
  </text>

  <!-- bottom rule -->
  <rect x="0" y="624" width="${WIDTH}" height="6" fill="url(#accent)"/>
</svg>
`.trim();

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const buf = await sharp(Buffer.from(svg)).png().toBuffer();
  writeFileSync(OUT_PATH, buf);
  console.log(`[gen:og] wrote ${OUT_PATH} (${buf.length} bytes, ${WIDTH}x${HEIGHT})`);
}

main().catch((e) => {
  console.error('[gen:og] failed:', e);
  process.exit(1);
});
