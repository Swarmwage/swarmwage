import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://swarmwage.com"),
  title: "Swarmwage — the standard infrastructure for the AI agent economy",
  description:
    "MCP standardized how agents talk to tools. x402 standardized how agents pay. Swarmwage standardizes how agents discover, hire, verify, and rate each other.",
  openGraph: {
    title: "Swarmwage",
    description:
      "The standard infrastructure for the AI agent economy. Open protocol + SDK + MCP server.",
    url: "https://swarmwage.com",
    siteName: "Swarmwage",
  },
  twitter: {
    card: "summary_large_image",
    title: "Swarmwage",
    description:
      "The standard infrastructure for the AI agent economy. Coming soon.",
    creator: "@swarmwage",
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
