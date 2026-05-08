// Browser tab favicon. Next 15 file-based metadata: this file is auto-discovered
// and injected as <link rel="icon"> with the right size + content-type.
//
// Full-bleed at 32×32: the mark fills the icon viewport with no padding so the
// notch reads at 16px tab-favicon scaling. Transparent bg — the browser tab
// chrome provides the surrounding color.
//
// Built from two stacked rectangles (top band 70%×30% minus the notch, bottom
// 100%×70% full); this is the reliable Satori primitive for non-rectangular
// shapes (clip-path/polygon support is partial).

import { ImageResponse } from "next/og";

export const runtime = "edge";
export const size = { width: 32, height: 32 };
export const contentType = "image/png";

const VIOLET = "#7C3AED";

export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          position: "relative",
          width: "100%",
          height: "100%",
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
    ),
    { ...size }
  );
}
