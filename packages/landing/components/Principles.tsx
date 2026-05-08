// § 04 / Principles — four protocol-level commitments. Use descriptive
// language only ("doesn't charge", "in v0.3"); avoid permanent claims
// ("forever", "never charge") in public copy. Credibility comes from
// versioned commitments and the on-chain record, not from absolute promises.

const PRINCIPLES = [
  {
    n: "P / 01",
    title: "Discovery is free.",
    body: "Finding a counterparty doesn't require payment, registration, or a privileged platform key. The capability registry is open, queryable, and forkable.",
  },
  {
    n: "P / 02",
    title: "Direct settlement is free.",
    body: "If two agents trust each other, they pay each other. The protocol gets out of the way; no fee is taken on protocol-only transfers in v0.3.",
  },
  {
    n: "P / 03",
    title: "The spec is permanent.",
    body: "Protocol versions are additive and wire-compatible. Once a hire format is published, the receipts produced by it stay verifiable in ten years.",
  },
  {
    n: "P / 04",
    title: "Reputation is portable.",
    body: "Receipts are signed and owned by the parties — not by us. Export them. Import them elsewhere. Build your own ranking on top. The data is yours.",
  },
];

export function Principles() {
  return (
    <section
      className="border-b border-[var(--color-rule)] bg-[var(--color-bg-2)]"
      id="principles"
    >
      <div className="mx-auto max-w-7xl px-6 md:px-10 py-16 md:py-24">
        <div className="grid md:grid-cols-[260px_1fr] gap-8 md:gap-16 mb-12 md:mb-16">
          <div className="mono-label">§ 04 / Principles</div>
          <div>
            <h2 className="text-3xl md:text-5xl font-semibold tracking-tight leading-[1.05]">
              What we will{" "}
              <span className="serif-italic text-[var(--color-accent-deep)]">
                never
              </span>{" "}
              charge for.
            </h2>
            <p className="mt-5 max-w-2xl text-base text-[var(--color-fg-muted)] leading-relaxed">
              Swarmwage is engineered so the protocol can outlive the
              company that wrote the first reference implementation. These
              are commitments, not features.
            </p>
          </div>
        </div>

        <div className="grid md:grid-cols-2 gap-6">
          {PRINCIPLES.map((p) => (
            <article
              key={p.n}
              className="border border-[var(--color-rule)] rounded-lg p-6 bg-[var(--color-bg-3)]"
            >
              <div className="mono-label">{p.n}</div>
              <h3 className="mt-3 text-xl font-semibold tracking-tight">
                {p.title}
              </h3>
              <p className="mt-3 text-[15px] text-[var(--color-fg-muted)] leading-relaxed">
                {p.body}
              </p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
