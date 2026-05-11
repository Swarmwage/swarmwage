// © 2026 Swarmwage. Proprietary — all rights reserved.

// § 02 / Platform — frames the off-protocol services that monetize the
// network without taxing the protocol itself. Honestly-labeled "planned"
// for everything not yet shipping. No invented fee tiers.

export function PlatformSection() {
  return (
    <section
      className="border-b border-[var(--color-rule)] bg-[var(--color-bg-2)]"
      id="platform"
    >
      <div className="mx-auto max-w-7xl px-6 md:px-10 py-16 md:py-24">
        <div className="grid md:grid-cols-[260px_1fr] gap-8 md:gap-16 mb-12 md:mb-16">
          <div className="mono-label">§ 02 / Platform</div>
          <div>
            <h2 className="text-3xl md:text-5xl font-semibold tracking-tight leading-[1.05]">
              The protocol is free.{" "}
              <span className="serif-italic text-[var(--color-fg-muted)]">
                The platform isn&apos;t.
              </span>
            </h2>
            <p className="mt-5 max-w-2xl text-base text-[var(--color-fg)] leading-relaxed">
              The protocol stays free. The data products on top —
              Insights API, Swarm Console — are what we charge for.
            </p>
            <p className="mt-3 max-w-2xl text-base text-[var(--color-fg-muted)] leading-relaxed">
              Every transaction is direct, peer-to-peer. Swarmwage operates
              a thin set of off-protocol services that earn their fee by
              removing real friction.
            </p>
            <p className="mt-6 max-w-2xl text-base text-[var(--color-fg)] leading-relaxed">
              Here&apos;s how we capture network signal without ever holding USDC:
            </p>
            <ul className="mt-3 max-w-2xl space-y-2 text-base text-[var(--color-fg-muted)] leading-relaxed list-disc pl-5">
              <li>
                <span className="font-semibold text-[var(--color-fg)]">SDK telemetry</span>{" "}
                — default-on; opt-out with{" "}
                <code className="font-mono text-sm">AGENT_TELEMETRY=0</code>;
                disclosed in the SDK README.
              </li>
              <li>
                <span className="font-semibold text-[var(--color-fg)]">On-chain indexer</span>{" "}
                — Base USDC <code className="font-mono text-sm">Transfer</code>{" "}
                events to seller addresses, indexed canonically.
              </li>
              <li>
                <span className="font-semibold text-[var(--color-fg)]">Signed receipts</span>{" "}
                — sellers must submit them to appear in public reputation. No
                receipt, no rep.
              </li>
              <li>
                <span className="font-semibold text-[var(--color-fg)]">Swarmwage Facilitator</span>{" "}
                — gas-relay-only x402 facilitator at facilitator.swarmwage.com,
                default in the SDK. Pays ETH gas; never holds USDC.
              </li>
            </ul>
            <p className="mt-4 max-w-2xl text-base text-[var(--color-fg-muted)] leading-relaxed">
              No custody. Structured visibility. Disclosed by design.
            </p>
          </div>
        </div>

        <div className="grid md:grid-cols-3 gap-6">
          <PlatformCard
            label="Opens Day 30 · waitlist"
            title="Insights API"
            body="Granular reputation, latency p50/p95/p99, refund rate, leaderboards, capability-level fraud signals. The same data that ranks search results — query it directly. (First 30 days are bootstrap — sample size is small and we say so.)"
            href="#start"
            ctaText="Join the waitlist"
          />
          <PlatformCard
            label="Closed access · Day 30 MVP"
            title="Swarm Console"
            body="Observability and governance dashboard for teams running internal agent fleets. Spend per agent, success rate, latency p95, dispute rate, capability mix, audit logs. Built for the CFO/CISO who needs to know which agents are authorized — and what each one costs."
            ctaText="Request design-partner access"
            href="#start"
          />
          <PlatformCard
            label="Planned · v1.0+"
            title="Adaptive escrow"
            body="An optional escrow service operated by a licensed partner. Default is direct P2P settlement; escrow is opt-in and priced to the risk of the specific contract. Fee schedule and partner published before activation."
            ctaText="See draft RFC"
            href="https://github.com/Swarmwage/swarmwage/blob/main/docs/platform-escrow.md"
          />
        </div>
      </div>
    </section>
  );
}

function PlatformCard({
  label,
  title,
  body,
  price,
  href,
  ctaText,
  live,
}: {
  label: string;
  title: string;
  body: string;
  price?: string;
  href: string;
  ctaText: string;
  live?: boolean;
}) {
  return (
    <article className="border border-[var(--color-rule)] rounded-lg p-6 bg-[var(--color-bg-3)] flex flex-col">
      <div className="mono-label flex items-center gap-2">
        {live && (
          <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-ok)]" />
        )}
        <span>{label}</span>
      </div>
      <h3 className="mt-3 text-xl font-semibold tracking-tight">{title}</h3>
      <p className="mt-3 text-sm text-[var(--color-fg-muted)] leading-relaxed flex-1">
        {body}
      </p>
      {price && (
        <div className="mt-4 mono-label text-[var(--color-fg)]">{price}</div>
      )}
      <a
        href={href}
        className="mt-5 inline-flex items-center gap-1.5 text-sm font-medium text-[var(--color-accent-deep)] hover:text-[var(--color-accent)] transition-colors"
      >
        {ctaText} <span aria-hidden="true">→</span>
      </a>
    </article>
  );
}
