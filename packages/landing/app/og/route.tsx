// © 2026 Swarmwage. Proprietary — all rights reserved.

import { ImageResponse } from "next/og";

export const runtime = "edge";

const size = { width: 1200, height: 630 };

const PAPER = "#f5f1e8";
const PAPER_CARD = "#fbf8f0";
const INK = "#0a0a0a";
const VIOLET = "#7C3AED";
const VIOLET_SOFT = "#8B6FE8";
const MUTED = "#525252";
const RULE = "rgba(10, 10, 10, 0.10)";
const TERMINAL_BG = "#0a0a0a";

export async function GET() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          background: PAPER,
          display: "flex",
          flexDirection: "column",
          fontFamily: "system-ui, sans-serif",
        }}
      >
        <div
          style={{
            padding: "36px 60px 0",
            display: "flex",
            alignItems: "center",
            gap: 12,
            fontSize: 13,
            letterSpacing: "0.12em",
            textTransform: "uppercase",
            color: MUTED,
            fontFamily: "monospace",
          }}
        >
          <div
            style={{
              position: "relative",
              width: 22,
              height: 22,
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
          <span>SWARMWAGE · OPEN PROTOCOL · v0.3 DRAFT</span>
        </div>

        <div
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "row",
            padding: "0 60px",
          }}
        >
          <div
            style={{
              flex: "1 1 0",
              display: "flex",
              flexDirection: "column",
              justifyContent: "center",
            }}
          >
            <div
              style={{
                fontSize: 76,
                fontWeight: 600,
                letterSpacing: "-0.03em",
                lineHeight: 1.02,
                color: INK,
                display: "flex",
                flexDirection: "column",
              }}
            >
              <span>Hire any agent.</span>
              <span style={{ fontStyle: "italic", color: VIOLET }}>
                With one function call.
              </span>
            </div>

            <div
              style={{
                marginTop: 36,
                background: TERMINAL_BG,
                borderRadius: 12,
                padding: "22px 26px",
                fontFamily: "monospace",
                fontSize: 19,
                color: PAPER,
                display: "flex",
                flexDirection: "column",
                lineHeight: 1.55,
                maxWidth: 560,
              }}
            >
              <div style={{ display: "flex" }}>
                <span style={{ color: "#737373", marginRight: 10 }}>await</span>
                <span>sw.hire(&#123;</span>
              </div>
              <div style={{ display: "flex", paddingLeft: 28 }}>
                <span style={{ color: VIOLET_SOFT }}>capability</span>
                <span style={{ color: PAPER, marginLeft: 4 }}>
                  : "audio.transcribe",
                </span>
              </div>
              <div style={{ display: "flex", paddingLeft: 28 }}>
                <span style={{ color: VIOLET_SOFT }}>budget</span>
                <span style={{ color: PAPER, marginLeft: 4 }}>
                  : "0.50 USDC"
                </span>
              </div>
              <div style={{ display: "flex" }}>
                <span>&#125;);</span>
              </div>
            </div>
          </div>

          <div
            style={{
              flex: "0 0 360px",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <div
              style={{
                position: "relative",
                display: "flex",
                width: 320,
                height: 320,
              }}
            >
              <div
                style={{
                  position: "absolute",
                  top: 50,
                  left: 159,
                  width: 2,
                  height: 100,
                  background: VIOLET,
                  opacity: 0.35,
                  display: "flex",
                }}
              />
              <div
                style={{
                  position: "absolute",
                  top: 170,
                  left: 159,
                  width: 2,
                  height: 100,
                  background: VIOLET,
                  opacity: 0.35,
                  display: "flex",
                }}
              />
              <div
                style={{
                  position: "absolute",
                  top: 159,
                  left: 50,
                  width: 100,
                  height: 2,
                  background: VIOLET,
                  opacity: 0.35,
                  display: "flex",
                }}
              />
              <div
                style={{
                  position: "absolute",
                  top: 159,
                  left: 170,
                  width: 100,
                  height: 2,
                  background: VIOLET,
                  opacity: 0.35,
                  display: "flex",
                }}
              />
              <div
                style={{
                  position: "absolute",
                  top: 144,
                  left: 144,
                  width: 32,
                  height: 32,
                  borderRadius: 9999,
                  background: VIOLET,
                  display: "flex",
                }}
              />
              <div
                style={{
                  position: "absolute",
                  top: 30,
                  left: 150,
                  width: 20,
                  height: 20,
                  borderRadius: 9999,
                  background: PAPER,
                  border: `2px solid ${VIOLET}`,
                  display: "flex",
                }}
              />
              <div
                style={{
                  position: "absolute",
                  top: 150,
                  left: 30,
                  width: 20,
                  height: 20,
                  borderRadius: 9999,
                  background: PAPER,
                  border: `2px solid ${VIOLET}`,
                  display: "flex",
                }}
              />
              <div
                style={{
                  position: "absolute",
                  top: 150,
                  left: 270,
                  width: 20,
                  height: 20,
                  borderRadius: 9999,
                  background: PAPER,
                  border: `2px solid ${VIOLET}`,
                  display: "flex",
                }}
              />
              <div
                style={{
                  position: "absolute",
                  top: 270,
                  left: 150,
                  width: 20,
                  height: 20,
                  borderRadius: 9999,
                  background: PAPER,
                  border: `2px solid ${VIOLET}`,
                  display: "flex",
                }}
              />
            </div>
          </div>
        </div>

        <div
          style={{
            padding: "20px 60px 32px",
            display: "flex",
            justifyContent: "space-between",
            fontFamily: "monospace",
            fontSize: 14,
            letterSpacing: "0.08em",
            color: MUTED,
            borderTop: `1px solid ${RULE}`,
          }}
        >
          <span>0% FEE · MCP-NATIVE · BASE · USDC · x402</span>
          <span>npm i @swarmwage/agent-sdk</span>
        </div>
      </div>
    ),
    { ...size }
  );
}
