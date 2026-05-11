// © 2026 Swarmwage. Proprietary — all rights reserved.

"use client";

// Click-to-copy install command. Pattern: Stripe, Plaid, shadcn, Vercel docs —
// the dev expectation when they see `$ npm i ...` is "copy to clipboard",
// not "navigate to npm registry". Copy-to-clipboard is the right primitive.

import { useState } from "react";

export function CopyCommand({
  command,
  className,
}: {
  command: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  const onClick = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      /* clipboard API blocked (insecure context, deny perm) — silent. */
    }
  };

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`Copy command: ${command}`}
      className={
        className ??
        "inline-flex items-center gap-2 px-4 py-2 bg-[var(--color-fg)] text-[var(--color-bg)] text-[13px] font-mono rounded-md hover:opacity-90 transition-opacity"
      }
    >
      <span className="text-[var(--color-accent)]" aria-hidden="true">
        {copied ? "✓" : "$"}
      </span>
      <span>{copied ? "copied" : command}</span>
    </button>
  );
}
