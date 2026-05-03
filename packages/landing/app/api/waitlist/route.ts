// Waitlist signup API.
// Posts each signup to a Discord webhook. Configure via env:
//   WAITLIST_DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...
// If the env var is missing, signups are accepted but only logged server-side.

import { NextResponse } from "next/server";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export const runtime = "nodejs";

export async function POST(req: Request) {
  let body: { email?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const email = (body.email ?? "").trim().toLowerCase();
  if (!email || !EMAIL_RE.test(email) || email.length > 254) {
    return NextResponse.json({ error: "Invalid email" }, { status: 400 });
  }

  const webhook = process.env.WAITLIST_DISCORD_WEBHOOK_URL;
  if (webhook) {
    try {
      await fetch(webhook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: `New waitlist signup: \`${email}\` · ${new Date().toISOString()}`,
        }),
      });
    } catch (err) {
      console.error("waitlist: webhook post failed", err);
      // Don't fail the user — we have their email server-side, just log it
    }
  } else {
    console.log("waitlist signup:", email, new Date().toISOString());
  }

  return NextResponse.json({ ok: true });
}
