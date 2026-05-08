// © 2026 Swarmwage. Proprietary — all rights reserved.

import { Nav } from "../components/Nav";
import { Hero } from "../components/Hero";
import { Triptych } from "../components/Triptych";
import { PlatformSection } from "../components/PlatformSection";
import { BountyBoard } from "../components/BountyBoard";
import { Principles } from "../components/Principles";
import { Faq } from "../components/Faq";
import { CTA } from "../components/CTA";
import { Footer } from "../components/Footer";

export default function HomePage() {
  return (
    <main className="min-h-screen bg-[var(--color-bg)] text-[var(--color-fg)] selection:bg-[var(--color-accent)] selection:text-white">
      <Nav />
      <Hero />
      <Triptych />
      <PlatformSection />
      <BountyBoard />
      <Principles />
      <Faq />
      <CTA />
      <Footer />
    </main>
  );
}
