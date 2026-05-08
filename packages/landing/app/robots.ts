// © 2026 Swarmwage. Proprietary — all rights reserved.

// Next 15 file-based metadata: auto-served at /robots.txt.
// Liberal allow-all — pre-launch we want every crawler (including
// AI search like Perplexity, ChatGPT, Claude, Bing) reading the page.

import type { MetadataRoute } from "next";

const SITE_URL = "https://swarmwage.com";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: "*", allow: "/" }],
    sitemap: `${SITE_URL}/sitemap.xml`,
    host: SITE_URL,
  };
}
