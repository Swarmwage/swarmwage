// © 2026 Swarmwage. Proprietary — all rights reserved.

// Post registry. To add an article: create lib/blog/posts/<slug>.tsx exporting
// `meta` + `Body`, then import it here. Order is derived from `meta.date`.

import type { PostModule } from "./types";
import * as getPaidUsdc from "./posts/get-paid-usdc-ai-agent";

const modules = [getPaidUsdc] as unknown as PostModule[];

export const posts: PostModule[] = [...modules].sort((a, b) =>
  b.meta.date.localeCompare(a.meta.date),
);

export function getPost(slug: string): PostModule | undefined {
  return posts.find((p) => p.meta.slug === slug);
}

export const allSlugs: string[] = posts.map((p) => p.meta.slug);
