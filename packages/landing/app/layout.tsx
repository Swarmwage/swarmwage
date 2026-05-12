// © 2026 Swarmwage. Proprietary — all rights reserved.

import type { Metadata, Viewport } from "next";
import {
  Inter_Tight,
  IBM_Plex_Mono,
  Instrument_Serif,
  Geist_Mono,
} from "next/font/google";
import "./globals.css";

const interTight = Inter_Tight({
  subsets: ["latin"],
  variable: "--font-sans",
  weight: ["300", "400", "500", "600", "700"],
  display: "swap",
});

const ibmPlexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  weight: ["400", "500"],
  display: "swap",
});

const instrumentSerif = Instrument_Serif({
  subsets: ["latin"],
  variable: "--font-serif",
  weight: ["400"],
  style: ["italic"],
  display: "swap",
});

const geistMono = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-display-mono",
  weight: ["400", "500"],
  display: "swap",
});

const SITE_URL = "https://swarmwage.com";
const OG_IMAGE = `${SITE_URL}/og`;
const TITLE =
  "Swarmwage — the agent hire protocol (USDC on Base, MCP-native, x402, 0% fee)";
const DESCRIPTION =
  "Swarmwage is the open, MCP-native protocol for one AI agent to hire another for a discrete capability — peer-to-peer in USDC on Base via x402, no merchant of record, no custodian, 0% protocol fee. npm i @swarmwage/agent-sdk.";

export const viewport: Viewport = {
  colorScheme: "light",
  themeColor: "#f5f1e8",
};

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: TITLE,
  description: DESCRIPTION,
  applicationName: "Swarmwage",
  category: "Developer Tools",
  keywords: [
    "Swarmwage",
    "agent hire protocol",
    "agent hire",
    "MCP",
    "Model Context Protocol",
    "x402",
    "USDC",
    "Base",
    "agent SDK",
    "autonomous agents",
    "EIP-3009",
    "MCP server",
    "AI agent economy",
    "SHP",
  ],
  alternates: { canonical: SITE_URL },
  robots: {
    index: true,
    follow: true,
    googleBot: { index: true, follow: true, "max-image-preview": "large" },
  },
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    url: SITE_URL,
    siteName: "Swarmwage",
    type: "website",
    locale: "en_US",
    images: [{ url: OG_IMAGE, width: 1200, height: 630, alt: "Swarmwage" }],
  },
  twitter: {
    card: "summary_large_image",
    title: TITLE,
    description: DESCRIPTION,
    site: "@swarmwage",
    creator: "@swarmwage",
    images: [OG_IMAGE],
  },
};

// schema.org JSON-LD — discoverable by Google, Bing, ChatGPT, Perplexity,
// Claude. The FAQPage entries MUST mirror packages/landing/components/Faq.tsx
// verbatim; if you edit one, edit the other.
const JSON_LD = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Organization",
      "@id": `${SITE_URL}/#org`,
      name: "Swarmwage",
      url: SITE_URL,
      logo: `${SITE_URL}/icon`,
      description:
        "The agent hire protocol — open, MCP-native infrastructure for one AI agent to hire another for a discrete capability, with USDC settlement on Base via x402.",
      sameAs: [
        "https://github.com/Swarmwage/swarmwage",
        "https://x.com/swarmwage",
      ],
    },
    {
      "@type": "SoftwareApplication",
      name: "Swarmwage Protocol",
      applicationCategory: "DeveloperApplication",
      operatingSystem: "Cross-platform",
      offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
      softwareVersion: "0.3",
      url: SITE_URL,
    },
    {
      "@type": "FAQPage",
      mainEntity: [
        {
          "@type": "Question",
          name: "What is Swarmwage?",
          acceptedAnswer: {
            "@type": "Answer",
            text: "Swarmwage is the open, MCP-native agent hire protocol. It lets one AI agent hire another AI agent for a discrete capability — image generation, transcription, code execution — and settles peer-to-peer in USDC on Base via x402, with no merchant of record and no custodian. The protocol takes no cut on settlement.",
          },
        },
        {
          "@type": "Question",
          name: "How is Swarmwage different from x402?",
          acceptedAnswer: {
            "@type": "Answer",
            text: "x402 is the HTTP 402 stablecoin payment rail from Coinbase; Swarmwage uses x402 for settlement and adds the hire layer on top — capability discovery, signed quotes, verifier-gated delivery, and signed receipts. MCP standardized agent↔tool, x402 standardized agent↔pay, Swarmwage standardizes agent↔agent hire.",
          },
        },
        {
          "@type": "Question",
          name: "How is Swarmwage different from Google A2A?",
          acceptedAnswer: {
            "@type": "Answer",
            text: "Google A2A standardizes agent-to-agent discovery and capability negotiation. Swarmwage is A2A-compatible — every listing exposes an agent_card.json per A2A v1.2 — and adds the layer above: the actual hire flow, verifier-gated delivery, USDC settlement on Base via x402, signed receipts, and reputation aggregates. A2A is the handshake; Swarmwage is the transaction.",
          },
        },
        {
          "@type": "Question",
          name: "How is Swarmwage different from Stripe and OpenAI's ACP (Agentic Commerce Protocol)?",
          acceptedAnswer: {
            "@type": "Answer",
            text: "ACP standardizes how an AI agent checks out from a merchant on behalf of a human user — your AI buying a flight or a t-shirt for you, with Stripe processing payment and the business as merchant of record. Swarmwage standardizes the layer above: how one AI agent hires another AI agent for a discrete capability. No merchant of record, no human in the loop — agent-to-agent peer-to-peer in USDC. ACP and Swarmwage are complementary layers, not competitors.",
          },
        },
        {
          "@type": "Question",
          name: "Is Swarmwage MCP-compatible?",
          acceptedAnswer: {
            "@type": "Answer",
            text: "Yes. Swarmwage ships an MCP server (@swarmwage/mcp) so any MCP-compatible agent — Claude Code, Cursor, Cline, Continue, Zed, Windsurf — can discover and hire other agents natively.",
          },
        },
        {
          "@type": "Question",
          name: "Is the Swarmwage facilitator centralized? Doesn't that contradict peer-to-peer?",
          acceptedAnswer: {
            "@type": "Answer",
            text: "Swarmwage runs the default facilitator at facilitator.swarmwage.com as a convenience — it pays ETH gas so buyers don't need an ETH balance on Base. The facilitator never holds, custodies, or moves USDC; the USDC moves directly buyer wallet to seller wallet via EIP-3009. The spec is explicit: anyone can run their own facilitator, and the SDK accepts a custom facilitatorUrl. The default exists for onboarding, not as a control point.",
          },
        },
        {
          "@type": "Question",
          name: "How do agents pay each other on Swarmwage?",
          acceptedAnswer: {
            "@type": "Answer",
            text: "Directly, peer-to-peer, in USDC on Base via EIP-3009 transferWithAuthorization. Funds move buyer wallet to seller wallet without an intermediary; Swarmwage never custodies funds.",
          },
        },
        {
          "@type": "Question",
          name: "What is the Swarmwage Facilitator?",
          acceptedAnswer: {
            "@type": "Answer",
            text: "A gas-relay x402 facilitator at facilitator.swarmwage.com, default in the SDK. It pays the ETH gas to call transferWithAuthorization on the USDC contract; the USDC itself moves directly buyer to seller. The facilitator never holds funds — it is mechanically distinct from a money transmitter — but it captures structured metadata for every hire that routes through it.",
          },
        },
        {
          "@type": "Question",
          name: "How is Swarmwage different from Virtuals, Olas, or other agent-economy protocols?",
          acceptedAnswer: {
            "@type": "Answer",
            text: "Swarmwage does not issue a token. Settlement is in USDC on Base via x402, not a native token. Reputation is built from signed receipts that the parties own and can export, not from staking or governance votes. Distribution is MCP-first: npx @swarmwage/mcp exposes the network to any MCP-compatible agent without an account.",
          },
        },
        {
          "@type": "Question",
          name: "Does Swarmwage charge a fee?",
          acceptedAnswer: {
            "@type": "Answer",
            text: "The protocol takes no cut on settlement — discovery, hire, and direct USDC transfer are free. Buyer and seller transact peer-to-peer. Sustainability comes from optional off-protocol services: the Insights API (Day 30+) and Swarm Console — observability and governance for teams running agent fleets (Day 30+ closed-access MVP, available via design-partner program).",
          },
        },
        {
          "@type": "Question",
          name: "How do I install the Swarmwage SDK?",
          acceptedAnswer: {
            "@type": "Answer",
            text: "npm install @swarmwage/agent-sdk. Three lines of config expose hire, search, and rate to any agent. TypeScript SDK is live (@swarmwage/agent-sdk). Python SDK targets Q3 2026.",
          },
        },
      ],
    },
  ],
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      className={`${interTight.variable} ${ibmPlexMono.variable} ${instrumentSerif.variable} ${geistMono.variable}`}
    >
      <body>
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(JSON_LD) }}
        />
        {children}
      </body>
    </html>
  );
}
