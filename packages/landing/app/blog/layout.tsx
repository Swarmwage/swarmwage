// © 2026 Swarmwage. Proprietary — all rights reserved.

import type { ReactNode } from "react";
import { BlogHeader } from "../../components/blog/BlogHeader";
import { Footer } from "../../components/Footer";

export default function BlogLayout({ children }: { children: ReactNode }) {
  return (
    <main className="min-h-screen bg-[var(--color-bg)] text-[var(--color-fg)] selection:bg-[var(--color-accent)] selection:text-white">
      <BlogHeader />
      {children}
      <Footer />
    </main>
  );
}
