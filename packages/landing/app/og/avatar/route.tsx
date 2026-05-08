// /og/avatar?size=N — square brand avatar generator.
//
// Used to export PNG assets for Discord (512), X (400), GitHub org (500),
// and any other social square that demands a static asset. Same primitive as
// /icon and /apple-icon, scaled to the requested size.
//
// Usage:
//   curl -o discord-avatar.png "http://localhost:3003/og/avatar?size=512"
//   curl -o x-avatar.png       "http://localhost:3003/og/avatar?size=400"

import { ImageResponse } from "next/og";
import type { NextRequest } from "next/server";

export const runtime = "edge";

const PAPER = "#f5f1e8";
const VIOLET = "#7C3AED";

const MIN = 64;
const MAX = 2048;

function clampSize(raw: string | null): number {
  const n = Number.parseInt(raw ?? "512", 10);
  if (!Number.isFinite(n)) return 512;
  return Math.max(MIN, Math.min(MAX, n));
}

export async function GET(req: NextRequest) {
  const size = clampSize(req.nextUrl.searchParams.get("size"));

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          background: PAPER,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <div
          style={{
            position: "relative",
            width: "64%",
            height: "64%",
            display: "flex",
          }}
        >
          <div
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              width: "70%",
              height: "30%",
              background: VIOLET,
              display: "flex",
            }}
          />
          <div
            style={{
              position: "absolute",
              top: "30%",
              left: 0,
              width: "100%",
              height: "70%",
              background: VIOLET,
              display: "flex",
            }}
          />
        </div>
      </div>
    ),
    { width: size, height: size }
  );
}
