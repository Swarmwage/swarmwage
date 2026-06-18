// © 2026 Swarmwage. Proprietary — all rights reserved.

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getPost, posts } from "../../../lib/blog";
import { INTENT_LABEL } from "../../../lib/blog/types";
import { articleJsonLd } from "../../../lib/blog/jsonld";

const SITE_URL = "https://swarmwage.com";

export const dynamicParams = false;

export function generateStaticParams() {
  return posts.map((p) => ({ slug: p.meta.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const post = getPost(slug);
  if (!post) return {};
  const { meta } = post;
  const url = `${SITE_URL}/blog/${meta.slug}`;
  return {
    title: `${meta.title} — Swarmwage`,
    description: meta.description,
    keywords: meta.tags,
    alternates: { canonical: url },
    openGraph: {
      title: meta.title,
      description: meta.description,
      url,
      siteName: "Swarmwage",
      type: "article",
      publishedTime: meta.date,
      modifiedTime: meta.updated ?? meta.date,
      authors: ["Luciano Carallo"],
      tags: meta.tags,
    },
    twitter: {
      card: "summary_large_image",
      title: meta.title,
      description: meta.description,
    },
  };
}

function fmtDate(iso: string): string {
  return new Date(iso + "T00:00:00Z").toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

export default async function BlogPostPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const post = getPost(slug);
  if (!post) notFound();

  const { meta, Body } = post;

  return (
    <article className="mx-auto max-w-3xl px-6 py-16 md:py-24">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(articleJsonLd(meta)),
        }}
      />

      <nav className="mb-8 text-sm">
        <a
          href="/blog"
          className="text-[var(--color-fg-muted)] hover:text-[var(--color-fg)] transition-colors"
        >
          ← Blog
        </a>
      </nav>

      <header className="mb-8">
        <div className="mono-label mb-3 flex items-center gap-3 text-[var(--color-fg-muted)]">
          <span className="text-[var(--color-accent-deep)]">
            {INTENT_LABEL[meta.intent]}
          </span>
          <span aria-hidden="true">·</span>
          <span>{fmtDate(meta.date)}</span>
          <span aria-hidden="true">·</span>
          <span>{meta.readingMinutes} min read</span>
        </div>
        <h1 className="text-3xl md:text-5xl font-semibold tracking-tight leading-[1.1] text-[var(--color-fg)]">
          {meta.title}
        </h1>
      </header>

      <div className="text-[15px] md:text-base">
        <Body />
      </div>

      {meta.faq && meta.faq.length > 0 && (
        <section className="mt-8 border-t border-[var(--color-rule)] pt-8">
          <dl className="space-y-6">
            {meta.faq.map((f) => (
              <div key={f.q}>
                <dt className="font-semibold text-[var(--color-fg)]">{f.q}</dt>
                <dd className="mt-1 leading-relaxed text-[var(--color-fg)]/80">
                  {f.a}
                </dd>
              </div>
            ))}
          </dl>
        </section>
      )}

      <footer className="mt-12 border-t border-[var(--color-rule)] pt-8">
        <p className="text-sm text-[var(--color-fg-muted)]">
          Written by{" "}
          <a
            href="https://x.com/lucianocccc"
            target="_blank"
            rel="noopener noreferrer"
            className="text-[var(--color-fg)] hover:text-[var(--color-accent)] transition-colors"
          >
            Luciano Carallo
          </a>
          , building Swarmwage in public.
        </p>
      </footer>
    </article>
  );
}
