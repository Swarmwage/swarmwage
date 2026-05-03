"use client";

import { useState } from "react";

type Status = "idle" | "loading" | "ok" | "error";

export function WaitlistForm() {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [message, setMessage] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setStatus("loading");
    setMessage(null);
    try {
      const res = await fetch("/api/waitlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.error ?? "Something went wrong");
      }
      setStatus("ok");
      setMessage("You're on the list. We'll be in touch.");
      setEmail("");
    } catch (err) {
      setStatus("error");
      setMessage((err as Error).message);
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex gap-2">
      <input
        type="email"
        required
        placeholder="you@domain.com"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        className="flex-1 bg-[var(--color-bg-2)] border border-[var(--color-border)] rounded-md px-4 py-3 text-sm placeholder:text-[var(--color-fg-muted)] focus:outline-none focus:border-[var(--color-accent)] transition-colors"
        disabled={status === "loading"}
      />
      <button
        type="submit"
        disabled={status === "loading"}
        className="bg-[var(--color-accent)] hover:bg-[color-mix(in_srgb,var(--color-accent),white_10%)] disabled:opacity-60 text-white font-medium px-5 py-3 rounded-md text-sm transition-colors"
      >
        {status === "loading" ? "..." : "Join waitlist"}
      </button>
      {message && (
        <p
          className={`absolute mt-16 text-sm ${
            status === "ok" ? "text-emerald-400" : "text-rose-400"
          }`}
        >
          {message}
        </p>
      )}
    </form>
  );
}
