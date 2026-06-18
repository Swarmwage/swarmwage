// © 2026 Swarmwage. Proprietary — all rights reserved.

// Lightweight blog chrome. The homepage <Nav> uses in-page anchors (#protocol,
// #start) that don't exist off-home, so the blog gets its own header with real
// cross-page links.

import { Logo } from "../Logo";

export function BlogHeader() {
  return (
    <nav className="sticky top-0 z-50 border-b border-[var(--color-rule)] backdrop-blur-md bg-[var(--color-bg)]/85">
      <div className="mx-auto max-w-3xl px-6">
        <div className="flex items-center justify-between h-16">
          <Logo />
          <div className="flex items-center gap-6 text-sm text-[var(--color-fg-muted)]">
            <a
              className="hover:text-[var(--color-fg)] transition-colors"
              href="/blog"
            >
              Blog
            </a>
            <a
              className="hover:text-[var(--color-fg)] transition-colors"
              href="https://github.com/Swarmwage/swarmwage"
              target="_blank"
              rel="noopener noreferrer"
            >
              GitHub
            </a>
            <a
              href="/#start"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-[var(--color-fg)] text-[var(--color-bg)] text-[13px] font-medium rounded-md hover:opacity-90 transition-opacity"
            >
              Get started <span aria-hidden="true">→</span>
            </a>
          </div>
        </div>
      </div>
    </nav>
  );
}
