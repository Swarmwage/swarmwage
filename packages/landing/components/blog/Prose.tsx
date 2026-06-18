// © 2026 Swarmwage. Proprietary — all rights reserved.

// Prose primitives for blog bodies. No @tailwindcss/typography dependency —
// explicit components give us the semantic control GEO wants: real <h2>
// question headings, a direct-answer <Lead>, scannable lists, code blocks.

import type { ReactNode } from "react";

export function Lead({ children }: { children: ReactNode }) {
  return (
    <p className="text-lg md:text-xl leading-relaxed text-[var(--color-fg)] mb-8">
      {children}
    </p>
  );
}

export function H2({ children, id }: { children: ReactNode; id?: string }) {
  return (
    <h2
      id={id}
      className="scroll-mt-24 mt-12 mb-4 text-2xl md:text-3xl font-semibold tracking-tight text-[var(--color-fg)]"
    >
      {children}
    </h2>
  );
}

export function H3({ children, id }: { children: ReactNode; id?: string }) {
  return (
    <h3
      id={id}
      className="scroll-mt-24 mt-8 mb-3 text-xl font-semibold tracking-tight text-[var(--color-fg)]"
    >
      {children}
    </h3>
  );
}

export function P({ children }: { children: ReactNode }) {
  return (
    <p className="my-4 leading-relaxed text-[var(--color-fg)]/90">{children}</p>
  );
}

export function UL({ children }: { children: ReactNode }) {
  return (
    <ul className="my-4 ml-5 list-disc space-y-2 text-[var(--color-fg)]/90 marker:text-[var(--color-accent)]">
      {children}
    </ul>
  );
}

export function OL({ children }: { children: ReactNode }) {
  return (
    <ol className="my-4 ml-5 list-decimal space-y-2 text-[var(--color-fg)]/90 marker:text-[var(--color-fg-muted)]">
      {children}
    </ol>
  );
}

export function LI({ children }: { children: ReactNode }) {
  return <li className="leading-relaxed pl-1">{children}</li>;
}

export function A({ href, children }: { href: string; children: ReactNode }) {
  const external = href.startsWith("http");
  return (
    <a
      href={href}
      {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
      className="text-[var(--color-accent)] underline decoration-[var(--color-accent)]/30 underline-offset-2 hover:decoration-[var(--color-accent)] transition-colors"
    >
      {children}
    </a>
  );
}

export function Code({ children }: { children: ReactNode }) {
  return (
    <code className="font-mono text-[0.85em] px-1.5 py-0.5 rounded bg-[var(--color-bg-2)] text-[var(--color-accent-deep)]">
      {children}
    </code>
  );
}

export function CodeBlock({
  children,
  lang,
}: {
  children: string;
  lang?: string;
}) {
  return (
    <pre className="my-6 overflow-x-auto rounded-lg border border-[var(--color-rule)] bg-[var(--color-fg)] p-4 text-[13px] leading-relaxed">
      <code className="font-mono text-[var(--color-bg-3)]" data-lang={lang}>
        {children}
      </code>
    </pre>
  );
}

export function Callout({
  title,
  children,
}: {
  title?: string;
  children: ReactNode;
}) {
  return (
    <aside className="my-6 rounded-lg border-l-2 border-[var(--color-accent)] bg-[var(--color-bg-2)] px-5 py-4">
      {title && (
        <p className="mono-label mb-1 text-[var(--color-accent-deep)]">{title}</p>
      )}
      <div className="text-sm leading-relaxed text-[var(--color-fg)]/90">
        {children}
      </div>
    </aside>
  );
}
