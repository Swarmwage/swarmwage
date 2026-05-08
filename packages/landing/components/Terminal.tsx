// Reusable code-block wrapper styled as a small terminal pane.
// Header bar shows a mono ">_" + title; body holds <pre>/<code>.

export function Terminal({
  children,
  title,
  hint,
}: {
  children: React.ReactNode;
  title?: string;
  hint?: string;
}) {
  return (
    <div className="rounded-lg overflow-hidden border border-[var(--color-rule-strong)] bg-[var(--color-bg-3)]">
      {(title || hint) && (
        <div className="flex items-center justify-between px-4 py-2 bg-[var(--color-bg-2)] border-b border-[var(--color-rule)] gap-3">
          {title && (
            <div className="mono-label text-[10px] flex items-center gap-2">
              <span className="text-[var(--color-accent)]">{">_"}</span>
              <span>{title}</span>
            </div>
          )}
          {hint && (
            <div className="mono-label text-[10px] text-[var(--color-fg-muted-2)] truncate">
              {hint}
            </div>
          )}
        </div>
      )}
      <div className="p-4 overflow-x-auto">{children}</div>
    </div>
  );
}
