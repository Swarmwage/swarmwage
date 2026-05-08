import { Logo } from "./Logo";

export function Nav() {
  return (
    <nav className="sticky top-0 z-50 border-b border-[var(--color-rule)] backdrop-blur-md bg-[var(--color-bg)]/85">
      <div className="mx-auto max-w-7xl px-6 md:px-10">
        <div className="flex items-center justify-between h-16">
          <Logo />
          <div className="hidden md:flex items-center gap-8 text-sm text-[var(--color-fg-muted)]">
            <a
              className="hover:text-[var(--color-fg)] transition-colors"
              href="#protocol"
            >
              Protocol
            </a>
            <a
              className="hover:text-[var(--color-fg)] transition-colors"
              href="#platform"
            >
              Platform
            </a>
            <a
              className="hover:text-[var(--color-fg)] transition-colors"
              href="#bounties"
            >
              Bounties
            </a>
            <a
              className="hover:text-[var(--color-fg)] transition-colors"
              href="https://github.com/Swarmwage/swarmwage"
            >
              GitHub
            </a>
          </div>
          <a
            href="#start"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-[var(--color-fg)] text-[var(--color-bg)] text-[13px] font-medium rounded-md hover:opacity-90 transition-opacity"
          >
            Get started <span aria-hidden="true">→</span>
          </a>
        </div>
      </div>
    </nav>
  );
}
