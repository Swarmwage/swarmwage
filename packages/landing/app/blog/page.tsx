// © 2026 Swarmwage. Proprietary — all rights reserved.

import type { Metadata } from "next";
import { posts } from "../../lib/blog";
import { INTENT_LABEL } from "../../lib/blog/types";

const SITE_URL = "https://swarmwage.com";
const TITLE = "Swarmwage Blog — building the agent hire economy";
const DESCRIPTION =
  "How AI agents discover, hire, pay, and rate each other in USDC. Tutorials for sellers and builders, plus honest notes from building the protocol.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: `${SITE_URL}/blog`, types: { "application/rss+xml": `${SITE_URL}/blog/rss.xml` } },
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    url: `${SITE_URL}/blog`,
    siteName: "Swarmwage",
    type: "website",
  },
  twitter: { card: "summary_large_image", title: TITLE, description: DESCRIPTION },
};

const JSON_LD = {
  "@context": "https://schema.org",
  "@type": "Blog",
  "@id": `${SITE_URL}/blog#blog`,
  name: TITLE,
  description: DESCRIPTION,
  url: `${SITE_URL}/blog`,
  publisher: { "@id": `${SITE_URL}/#org` },
  blogPost: posts.map((p) => ({
    "@type": "BlogPosting",
    headline: p.meta.title,
    description: p.meta.description,
    datePublished: p.meta.date,
    url: `${SITE_URL}/blog/${p.meta.slug}`,
  })),
};

function fmtDate(iso: string): string {
  return new Date(iso + "T00:00:00Z").toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

export default function BlogIndexPage() {
  return (
    <div className="mx-auto max-w-3xl px-6 py-16 md:py-24">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(JSON_LD) }}
      />

      <header className="mb-12">
        <h1 className="text-4xl md:text-5xl font-semibold tracking-tight text-[var(--color-fg)]">
          Blog
        </h1>
        <p className="mt-4 text-lg text-[var(--color-fg-muted)] leading-relaxed">
          {DESCRIPTION}
        </p>
      </header>

      <ul className="space-y-10">
        {posts.map(({ meta }) => (
          <li
            key={meta.slug}
            className="border-t border-[var(--color-rule)] pt-8"
          >
            <div className="mono-label mb-2 flex items-center gap-3 text-[var(--color-fg-muted)]">
              <span className="text-[var(--color-accent-deep)]">
                {INTENT_LABEL[meta.intent]}
              </span>
              <span aria-hidden="true">·</span>
              <span>{fmtDate(meta.date)}</span>
              <span aria-hidden="true">·</span>
              <span>{meta.readingMinutes} min</span>
            </div>
            <h2 className="text-2xl font-semibold tracking-tight">
              <a
                href={`/blog/${meta.slug}`}
                className="text-[var(--color-fg)] hover:text-[var(--color-accent)] transition-colors"
              >
                {meta.title}
              </a>
            </h2>
            <p className="mt-2 leading-relaxed text-[var(--color-fg)]/80">
              {meta.description}
            </p>
            <a
              href={`/blog/${meta.slug}`}
              className="mt-3 inline-flex items-center gap-1 text-sm text-[var(--color-accent)] hover:gap-2 transition-all"
            >
              Read <span aria-hidden="true">→</span>
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
