// © 2026 Swarmwage. Proprietary — all rights reserved.

// Per-article schema.org JSON-LD. The @graph mirrors the page's visible content
// (lead → BlogPosting, FAQ section → FAQPage, numbered steps → HowTo) so Google
// and AI crawlers (ChatGPT, Perplexity, Claude) can extract a clean, citable
// answer. `publisher` references the Organization node defined in app/layout.tsx
// (@id = ${SITE_URL}/#org) — keep that id in sync if it ever changes.

import type { PostMeta } from "./types";

const SITE_URL = "https://swarmwage.com";

export function articleJsonLd(meta: PostMeta) {
  const url = `${SITE_URL}/blog/${meta.slug}`;

  const graph: Record<string, unknown>[] = [
    {
      "@type": "BlogPosting",
      "@id": `${url}#article`,
      headline: meta.title,
      description: meta.description,
      datePublished: meta.date,
      dateModified: meta.updated ?? meta.date,
      url,
      mainEntityOfPage: url,
      author: {
        "@type": "Person",
        name: "Luciano Carallo",
        url: "https://x.com/lucianocccc",
      },
      publisher: { "@id": `${SITE_URL}/#org` },
      keywords: meta.tags.join(", "),
      inLanguage: "en",
    },
    {
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "Home", item: SITE_URL },
        { "@type": "ListItem", position: 2, name: "Blog", item: `${SITE_URL}/blog` },
        { "@type": "ListItem", position: 3, name: meta.title, item: url },
      ],
    },
  ];

  if (meta.faq?.length) {
    graph.push({
      "@type": "FAQPage",
      mainEntity: meta.faq.map((f) => ({
        "@type": "Question",
        name: f.q,
        acceptedAnswer: { "@type": "Answer", text: f.a },
      })),
    });
  }

  if (meta.howTo) {
    graph.push({
      "@type": "HowTo",
      name: meta.howTo.name,
      step: meta.howTo.steps.map((s, i) => ({
        "@type": "HowToStep",
        position: i + 1,
        name: s.name,
        text: s.text,
      })),
    });
  }

  return { "@context": "https://schema.org", "@graph": graph };
}
