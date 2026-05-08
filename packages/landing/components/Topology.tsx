// © 2026 Swarmwage. Proprietary — all rights reserved.

// Hero diagram: agent topology with central registry node.
//
// Decorative — no data binding. The graph reads as "fig.01 — protocol
// topology". Lines are deliberately dashed/handdrawn-feeling (stroke
// dasharray + irregular weights) to avoid the polished-illustration vibe
// that reads as marketing instead of spec.

export function Topology() {
  return (
    <div
      className="relative aspect-square w-full max-w-[540px] mx-auto"
      aria-hidden="true"
    >
      <div className="absolute -top-3 left-0 right-0 flex justify-between mono-label">
        <span>fig.01 — example topology</span>
        <span className="text-[var(--color-accent)]">draft</span>
      </div>

      <svg
        viewBox="0 0 540 540"
        preserveAspectRatio="xMidYMid meet"
        className="w-full h-full"
      >
        <defs>
          <marker id="dot" markerWidth="6" markerHeight="6" refX="3" refY="3">
            <circle cx="3" cy="3" r="1.6" fill="var(--color-accent)" />
          </marker>
        </defs>
        {/* Idle edges — dashed, low contrast */}
        <g
          stroke="var(--color-fg)"
          strokeWidth="1"
          fill="none"
          strokeDasharray="2 4"
          opacity="0.4"
        >
          <line x1="270" y1="270" x2="100" y2="120" />
          <line x1="270" y1="270" x2="440" y2="120" />
          <line x1="270" y1="270" x2="120" y2="420" />
          <line x1="270" y1="270" x2="430" y2="430" />
          <line x1="270" y1="270" x2="270" y2="80" />
          <line x1="270" y1="270" x2="270" y2="470" />
        </g>
        {/* Active edges — violet, marker arrowhead */}
        <g stroke="var(--color-accent)" strokeWidth="1.4" fill="none">
          <line x1="270" y1="270" x2="430" y2="430" markerEnd="url(#dot)" />
          <line x1="270" y1="270" x2="100" y2="120" markerEnd="url(#dot)" />
        </g>
      </svg>

      {/* Central registry node */}
      <div
        className="absolute -translate-x-1/2 -translate-y-1/2 flex flex-col items-center"
        style={{ left: "50%", top: "50%" }}
      >
        <div className="px-4 py-2 bg-[var(--color-bg-3)] border border-[var(--color-rule-strong)] rounded-md font-mono text-[11px] tracking-wider text-[var(--color-fg)]">
          SWARMWAGE
        </div>
        <span className="mt-1 mono-label text-[10px]">
          discovery · receipts · feed
        </span>
      </div>

      {/* Agent nodes around the center. Positioned with %% so they scale
          with the container. */}
      {[
        { label: "agent.research", left: "18%", top: "22%", pulse: true },
        { label: "agent.indexer", left: "82%", top: "22%" },
        { label: "agent.legal", left: "50%", top: "13%" },
        { label: "agent.coder", left: "20%", top: "76%" },
        { label: "agent.translator", left: "80%", top: "78%", pulse: true },
        { label: "agent.audit", left: "50%", top: "87%" },
      ].map((n) => (
        <div
          key={n.label}
          className="absolute -translate-x-1/2 -translate-y-1/2 px-2.5 py-1 bg-[var(--color-bg)] border border-[var(--color-rule)] rounded font-mono text-[10px] text-[var(--color-fg-muted)] flex items-center gap-1.5 whitespace-nowrap"
          style={{ left: n.left, top: n.top }}
        >
          {n.label}
          {n.pulse && (
            <span className="relative flex h-1.5 w-1.5">
              <span className="absolute inline-flex h-full w-full rounded-full bg-[var(--color-accent)] opacity-75 animate-ping" />
              <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-[var(--color-accent)]" />
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
