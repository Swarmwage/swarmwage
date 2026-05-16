// © 2026 Swarmwage. MIT.
// Swarmwage seller-linkedin-enrich — Apify backend wrapper.
//
// Single backend: the harvestapi/linkedin-profile-scraper actor on Apify,
// called via the run-sync-get-dataset-items endpoint. Returns an array of
// profile objects; we take the first item and normalize it to the canonical
// shape declared by the `research.linkedin.profile.enrich` capability.
//
// Why harvestapi: 9M+ runs, $0.004/profile (cheaper than dev_fusion's $0.01),
// no full-permission approval required, real-world LinkedIn fields (about,
// experience, education, followerCount, etc.). The 'urls' input key (not
// 'profileUrls' as some Apify wrappers expect) is the working convention
// for this actor.
//
// Apify field names vary across actor versions; we map a superset of the
// common ones and fall back to null so the verifier downstream can still
// assert the minimum required fields (`url`, `name`).

export interface EnrichedProfile {
  url: string | null;
  name: string | null;
  headline: string | null;
  location: string | null;
  current_position: string | null;
  company: string | null;
  summary: string | null;
  skills: string[];
  source: "apify";
}

export interface EnrichMeta {
  backend_used: "apify";
  duration_ms: number;
}

export interface EnrichResult {
  profile: EnrichedProfile;
  meta: EnrichMeta;
}

export interface EnrichOptions {
  profileUrl: string;
  apifyApiToken: string;
  apifyTimeoutMs: number;
}

export class EnrichBackendError extends Error {
  readonly stage: "apify" | "all";
  constructor(stage: "apify" | "all", message: string) {
    super(message);
    this.stage = stage;
  }
}

// -------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------

function str(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

function firstNonEmpty(...vals: unknown[]): string | null {
  for (const v of vals) {
    const s = str(v);
    if (s) return s;
  }
  return null;
}

interface ApifyExperienceItem {
  title?: unknown;
  position?: unknown;
  companyName?: unknown;
  company?: unknown;
  company_name?: unknown;
}

interface ApifySkillItem {
  name?: unknown;
  title?: unknown;
}

interface ApifyProfile {
  url?: unknown;
  profileUrl?: unknown;
  linkedinUrl?: unknown;
  publicIdentifier?: unknown;

  fullName?: unknown;
  name?: unknown;
  firstName?: unknown;
  lastName?: unknown;

  headline?: unknown;
  subTitle?: unknown;

  location?: unknown;
  addressWithCountry?: unknown;
  geoLocationName?: unknown;

  about?: unknown;
  summary?: unknown;
  description?: unknown;

  jobTitle?: unknown;
  occupation?: unknown;
  currentPosition?: unknown;
  current_position?: unknown;
  currentCompany?: unknown;
  companyName?: unknown;
  company?: unknown;

  experience?: unknown;
  experiences?: unknown;
  positions?: unknown;

  skills?: unknown;
}

function normalizeProfile(raw: ApifyProfile, fallbackUrl: string): EnrichedProfile {
  const name =
    firstNonEmpty(raw.fullName, raw.name) ??
    (() => {
      const f = str(raw.firstName);
      const l = str(raw.lastName);
      if (!f && !l) return null;
      return [f, l].filter(Boolean).join(" ");
    })();

  // Pull the first experience entry if current position isn't a top-level field.
  let expTitle: string | null = null;
  let expCompany: string | null = null;
  const expArray = Array.isArray(raw.experience)
    ? raw.experience
    : Array.isArray(raw.experiences)
      ? raw.experiences
      : Array.isArray(raw.positions)
        ? raw.positions
        : null;
  if (expArray && expArray.length > 0) {
    const e = expArray[0] as ApifyExperienceItem;
    expTitle = firstNonEmpty(e.title, e.position);
    expCompany = firstNonEmpty(e.companyName, e.company, e.company_name);
  }

  let skills: string[] = [];
  if (Array.isArray(raw.skills)) {
    for (const s of raw.skills) {
      if (typeof s === "string") {
        const t = s.trim();
        if (t) skills.push(t);
      } else if (s && typeof s === "object") {
        const obj = s as ApifySkillItem;
        const t = firstNonEmpty(obj.name, obj.title);
        if (t) skills.push(t);
      }
    }
    if (skills.length > 50) skills = skills.slice(0, 50);
  }

  return {
    url:
      firstNonEmpty(raw.url, raw.profileUrl, raw.linkedinUrl) ??
      (() => {
        const id = str(raw.publicIdentifier);
        return id ? `https://www.linkedin.com/in/${id}` : fallbackUrl;
      })(),
    name,
    headline: firstNonEmpty(raw.headline, raw.subTitle),
    location: firstNonEmpty(raw.location, raw.addressWithCountry, raw.geoLocationName),
    current_position: firstNonEmpty(
      raw.jobTitle,
      raw.currentPosition,
      raw.current_position,
      raw.occupation,
      expTitle,
    ),
    company: firstNonEmpty(raw.currentCompany, raw.companyName, raw.company, expCompany),
    summary: firstNonEmpty(raw.about, raw.summary, raw.description),
    skills,
    source: "apify",
  };
}

// -------------------------------------------------------------------------
// Public entry point
// -------------------------------------------------------------------------

export async function enrichProfile(opts: EnrichOptions): Promise<EnrichResult> {
  const t0 = Date.now();
  const url = `https://api.apify.com/v2/acts/harvestapi~linkedin-profile-scraper/run-sync-get-dataset-items?token=${encodeURIComponent(opts.apifyApiToken)}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.apifyTimeoutMs);
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ urls: [opts.profileUrl] }),
      signal: controller.signal,
    });
  } catch (err) {
    throw new EnrichBackendError(
      "apify",
      `Apify fetch failed: ${(err as Error).message}`,
    );
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new EnrichBackendError(
      "apify",
      `Apify returned HTTP ${res.status}: ${txt.slice(0, 300)}`,
    );
  }

  let data: unknown;
  try {
    data = await res.json();
  } catch (err) {
    throw new EnrichBackendError(
      "apify",
      `Apify response was not valid JSON: ${(err as Error).message}`,
    );
  }

  if (!Array.isArray(data) || data.length === 0) {
    throw new EnrichBackendError(
      "apify",
      "Apify returned an empty dataset (profile may be private, blocked, or invalid)",
    );
  }

  const first = data[0];
  if (!first || typeof first !== "object") {
    throw new EnrichBackendError("apify", "Apify dataset item is not an object");
  }

  const profile = normalizeProfile(first as ApifyProfile, opts.profileUrl);

  return {
    profile,
    meta: {
      backend_used: "apify",
      duration_ms: Date.now() - t0,
    },
  };
}
