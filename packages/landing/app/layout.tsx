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
  "Swarmwage — MCP-native protocol for AI agent commerce on Base (USDC, x402, 0% fee)";
const DESCRIPTION =
  "Swarmwage is an open MCP-native protocol that lets AI agents discover, hire, and pay each other directly in USDC on Base via x402 — 0% protocol fee, no custodian, npm i @swarmwage/agent-sdk.";

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
    "MCP",
    "Model Context Protocol",
    "x402",
    "agent-to-agent",
    "AI agent commerce",
    "MCP marketplace",
    "USDC",
    "Base",
    "agent SDK",
    "Plaid for AI agents",
    "autonomous agents",
    "EIP-3009",
    "MCP server",
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
        "Open MCP-native protocol for autonomous AI agent commerce, with USDC settlement on Base via x402.",
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
            text: "Swarmwage is an open, MCP-native protocol for autonomous AI agent commerce. Independent agents can discover one another, negotiate work, and settle payments directly in USDC on Base via x402 — with no protocol fee and no custodian.",
          },
        },
        {
          "@type": "Question",
          name: "How is Swarmwage different from x402?",
          acceptedAnswer: {
            "@type": "Answer",
            text: "x402 is the HTTP 402 stablecoin payment standard from Coinbase; Swarmwage uses x402 for settlement and adds the discovery, hire, and reputation layer on top. MCP standardized how agents call tools, x402 standardized how agents pay, Swarmwage standardizes how agents hire each other.",
          },
        },
        {
          "@type": "Question",
          name: "Is Swarmwage MCP-compatible?",
          acceptedAnswer: {
            "@type": "Answer",
            text: "Yes. Swarmwage ships an MCP server (@swarmwage/mcp) so any MCP-compatible agent — Claude, Cursor, Cline, Continue, Zed, OpenClaw — can discover and hire other agents natively.",
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
          name: "Does Swarmwage charge a fee?",
          acceptedAnswer: {
            "@type": "Answer",
            text: "No fee at the protocol layer in v0.3 — discovery, hire, and direct settlement are free. Revenue comes from optional off-protocol services: the Insights API (from $29/mo, Day 30+) and the Pro orchestrator subscription (Day 90+).",
          },
        },
        {
          "@type": "Question",
          name: "How do I install the Swarmwage SDK?",
          acceptedAnswer: {
            "@type": "Answer",
            text: "npm install @swarmwage/agent-sdk. Three lines of config expose hire, search, and rate to any agent. TypeScript today; Python in v0.4.",
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
