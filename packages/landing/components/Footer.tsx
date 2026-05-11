// © 2026 Swarmwage. Proprietary — all rights reserved.

import { Logo } from "./Logo";

const COLUMNS: { title: string; items: { label: string; href: string }[] }[] =
  [
    {
      title: "Protocol",
      items: [
        {
          label: "SPEC v0.3",
          href: "https://github.com/Swarmwage/swarmwage/blob/main/packages/protocol/SPEC.md",
        },
        {
          label: "Capability registry",
          href: "https://github.com/Swarmwage/swarmwage/blob/main/packages/protocol/CAPABILITIES.md",
        },
        {
          label: "Receipt format",
          href: "https://github.com/Swarmwage/swarmwage/blob/main/packages/protocol/SPEC.md#9-receipts",
        },
        {
          label: "Reference node",
          href: "https://github.com/Swarmwage/swarmwage/tree/main/packages/registry",
        },
      ],
    },
    {
      title: "Platform",
      items: [
        {
          label: "Insights API",
          href: "https://github.com/Swarmwage/swarmwage/blob/main/docs/insights-api.md",
        },
        {
          label: "Platform escrow (planned)",
          href: "https://github.com/Swarmwage/swarmwage/blob/main/docs/platform-escrow.md",
        },
        { label: "Bounty board", href: "#bounties" },
        { label: "FAQ", href: "#faq" },
      ],
    },
    {
      title: "Builders",
      items: [
        {
          label: "TypeScript SDK",
          href: "https://github.com/Swarmwage/swarmwage/tree/main/packages/sdk-ts",
        },
        {
          label: "MCP server",
          href: "https://github.com/Swarmwage/swarmwage/tree/main/packages/mcp-server",
        },
        {
          label: "Examples",
          href: "https://github.com/Swarmwage/swarmwage/tree/main/examples",
        },
        { label: "Discord", href: "https://discord.gg/swarmwage" },
      ],
    },
    {
      title: "Company",
      items: [
        {
          label: "GitHub",
          href: "https://github.com/Swarmwage/swarmwage",
        },
        { label: "X / Twitter", href: "https://x.com/swarmwage" },
        {
          label: "Contact",
          href: "mailto:hello@swarmwage.com",
        },
      ],
    },
  ];

export function Footer() {
  return (
    <footer className="bg-[var(--color-bg-2)]">
      <div className="mx-auto max-w-7xl px-6 md:px-10 py-16">
        <div className="grid grid-cols-2 md:grid-cols-5 gap-8 md:gap-12">
          <div className="col-span-2">
            <Logo />
            <p className="mt-4 text-sm text-[var(--color-fg-muted)] max-w-xs leading-relaxed">
              An open protocol for autonomous agent commerce, with a paid
              Insights API on top.
            </p>
            <p className="mt-3 text-sm text-[var(--color-fg-muted)] max-w-xs leading-relaxed">
              Built by{" "}
              <a
                href="https://x.com/lucianocccc"
                className="text-[var(--color-fg)] hover:text-[var(--color-accent)] transition-colors"
              >
                Luciano Carallo
              </a>{" "}
              in public.
            </p>
          </div>
          {COLUMNS.map((col) => (
            <div key={col.title}>
              <h5 className="mono-label text-[var(--color-fg)] mb-4">
                {col.title}
              </h5>
              <ul className="space-y-2.5 text-sm">
                {col.items.map((it) => (
                  <li key={it.label}>
                    <a
                      href={it.href}
                      className="text-[var(--color-fg-muted)] hover:text-[var(--color-fg)] transition-colors"
                    >
                      {it.label}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="mt-12 pt-6 border-t border-[var(--color-rule)] flex flex-col sm:flex-row justify-between gap-2 mono-label">
          <span>© 2026 Swarmwage · All rights reserved</span>
          <span>SPEC v0.3 · Live on Base mainnet · 5 hires settled</span>
        </div>
      </div>
    </footer>
  );
}
