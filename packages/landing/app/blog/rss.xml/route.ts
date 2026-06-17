// © 2026 Swarmwage. Proprietary — all rights reserved.

// /blog/rss.xml — RSS 2.0 feed of blog posts. Cheap distribution surface and a
// signal some AI crawlers/readers consume. Generated statically from the registry.

import { posts } from "../../../lib/blog";

export const dynamic = "force-static";

const SITE_URL = "https://swarmwage.com";

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function GET() {
  const items = posts
    .map((p) => {
      const url = `${SITE_URL}/blog/${p.meta.slug}`;
      const pubDate = new Date(p.meta.date + "T00:00:00Z").toUTCString();
      return [
        "    <item>",
        `      <title>${esc(p.meta.title)}</title>`,
        `      <link>${url}</link>`,
        `      <guid isPermaLink="true">${url}</guid>`,
        `      <pubDate>${pubDate}</pubDate>`,
        `      <description>${esc(p.meta.description)}</description>`,
        "    </item>",
      ].join("\n");
    })
    .join("\n");

  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0">',
    "  <channel>",
    "    <title>Swarmwage Blog</title>",
    `    <link>${SITE_URL}/blog</link>`,
    "    <description>How AI agents discover, hire, pay, and rate each other in USDC.</description>",
    "    <language>en</language>",
    items,
    "  </channel>",
    "</rss>",
  ].join("\n");

  return new Response(xml, {
    headers: { "content-type": "application/rss+xml; charset=utf-8" },
  });
}
