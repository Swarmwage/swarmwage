// © 2026 Swarmwage. Proprietary — all rights reserved.

// iOS home-screen icon (180×180). Same primitive as /icon, scaled up with
// slightly more breathing room to match Apple's icon padding convention.

import { ImageResponse } from "next/og";

export const runtime = "edge";
export const size = { width: 180, height: 180 };
export const contentType = "image/png";

const PAPER = "#f5f1e8";
const VIOLET = "#7C3AED";

export default function AppleIcon() {
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
            width: "56%",
            height: "56%",
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
    { ...size }
  );
}
