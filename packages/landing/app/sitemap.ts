// © 2026 Swarmwage. Proprietary — all rights reserved.

// Next 15 file-based metadata: auto-served at /sitemap.xml.
// Single-page landing today; in-page anchors (#platform, #faq, #start)
// are not added — sitemap entries are full URLs only.
//
// `lastModified` MUST be a stable constant, not `new Date()`. A fresh
// `Date` mutates on every request and emits a misleading `<lastmod>` to
// crawlers, which Google flags as spurious churn and may suppress in
// indexing. Bump LAST_MODIFIED manually when meaningful content lands.

import type { MetadataRoute } from "next";

const SITE_URL = "https://swarmwage.com";
const LAST_MODIFIED = new Date("2026-05-09T00:00:00Z");

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    {
      url: SITE_URL,
      lastModified: LAST_MODIFIED,
      changeFrequency: "weekly",
      priority: 1.0,
    },
  ];
}
