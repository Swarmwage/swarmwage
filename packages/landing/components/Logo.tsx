// Wordmark + notched-square primary mark.
//
// Three variants:
//   "lockup"   — mark + wordmark side-by-side (default; for Nav/Footer)
//   "wordmark" — pure type, no mark (for body copy / inline references)
//   "mark"     — solo notched square (for tight contexts)
//
// Wordmark = Geist Mono lowercase + violet dot terminator.
// Mark     = notched square (see Logomark.tsx for geometry).
// Both share the same accent color (var(--color-accent)).

import { Logomark } from "./Logomark";

type Variant = "lockup" | "wordmark" | "mark";

export function Logo({
  size = 15,
  variant = "lockup",
  asLink = true,
}: {
  size?: number;
  variant?: Variant;
  asLink?: boolean;
}) {
  const markSize = Math.round(size * 1.15);

  const wordmark = (
    <span
      className="wordmark inline-flex items-baseline text-[var(--color-fg)]"
      style={{ fontSize: `${size}px` }}
    >
      <span>swarmwage</span>
      <span
        aria-hidden="true"
        className="text-[var(--color-accent)]"
        style={{ marginLeft: "0.02em" }}
      >
        .
      </span>
    </span>
  );

  let inner;
  if (variant === "wordmark") {
    inner = wordmark;
  } else if (variant === "mark") {
    inner = (
      <span className="inline-flex text-[var(--color-accent)]">
        <Logomark size={markSize} />
      </span>
    );
  } else {
    inner = (
      <span className="inline-flex items-center gap-[0.5em]">
        <span className="inline-flex text-[var(--color-accent)]">
          <Logomark size={markSize} />
        </span>
        {wordmark}
      </span>
    );
  }

  if (!asLink) return inner;

  return (
    <a href="/" aria-label="Swarmwage — home" className="inline-flex">
      {inner}
    </a>
  );
}
