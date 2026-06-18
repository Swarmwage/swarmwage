// © 2026 Swarmwage. Proprietary — all rights reserved.

// Blog content model. Posts are typed TS/TSX modules (no MDX dependency): each
// post file exports `meta` + a `Body` component. This keeps full control over
// semantic HTML — which is what GEO (getting cited by LLM answers) rewards:
// question-form headings, direct-answer leads, FAQ/HowTo blocks that mirror the
// JSON-LD emitted on the page.

import type { ComponentType } from "react";

export type BlogIntent = "seller" | "builder" | "positioning";

export interface FaqItem {
  q: string;
  a: string;
}

export interface HowToStep {
  name: string;
  text: string;
}

export interface HowTo {
  name: string;
  steps: HowToStep[];
}

export interface PostMeta {
  /** URL slug — /blog/<slug>. Stable once published (receipts/links depend on it). */
  slug: string;
  /** h1 + SEO <title>. Prefer the exact phrasing of the query it should rank for. */
  title: string;
  /** Meta description AND the on-page direct-answer lead. Keep to 1-2 sentences. */
  description: string;
  /** ISO yyyy-mm-dd. */
  date: string;
  /** ISO yyyy-mm-dd, if materially revised after publish. */
  updated?: string;
  tags: string[];
  /** Which side of the marketplace this post serves. Drives the index filter chip. */
  intent: BlogIntent;
  /** Mirrored both as an on-page FAQ section and as FAQPage JSON-LD. */
  faq?: FaqItem[];
  /** Emitted as HowTo JSON-LD (and ideally reflected by the body's numbered steps). */
  howTo?: HowTo;
  readingMinutes: number;
}

export interface PostModule {
  meta: PostMeta;
  Body: ComponentType;
}

export const INTENT_LABEL: Record<BlogIntent, string> = {
  seller: "For sellers",
  builder: "For builders",
  positioning: "Positioning",
};
