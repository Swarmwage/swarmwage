// © 2026 Swarmwage. Proprietary — all rights reserved.

// Next 15 file-based metadata: auto-served at /sitemap.xml.
// Single-page landing today; in-page anchors (#platform, #bounties, #faq,
// #start) are not added — sitemap entries are full URLs only.

import type { MetadataRoute } from "next";

const SITE_URL = "https://swarmwage.com";

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    {
      url: SITE_URL,
      lastModified: new Date(),
      changeFrequency: "weekly",
      priority: 1.0,
    },
  ];
}
