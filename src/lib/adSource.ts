/**
 * Where a visitor came from: the Google Ads click ID and campaign tags from
 * the link they arrived on, kept in our own first-party cookie (jpai_src)
 * for 90 days and copied onto the account at signup, so we can see which
 * ads and links bring customers and not just visits. Also reads the Google
 * Analytics browser ID (the _ga cookie) that steps reported from our
 * servers are linked to (src/lib/serverEvents.ts).
 *
 * The Privacy Policy (section 2, "Where you came from") describes exactly
 * this. The cookie is set only on pages where the tags may run and only
 * when trackingAllowed() says so (src/components/MarketingTags.tsx), and
 * the server copies it only when the signup request carries no opt-out.
 *
 * Pure functions, safe in the browser and on the server.
 */

export const SOURCE_COOKIE = "jpai_src";
export const SOURCE_MAX_AGE_SECONDS = 90 * 24 * 60 * 60;

export interface AdSource {
  gclid?: string;
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  utm_term?: string;
  /** The page they first landed on, path only. */
  landing?: string;
}

/** The query parameters we keep, with the longest value accepted for each. */
const PARAMS: Record<Exclude<keyof AdSource, "landing">, number> = {
  gclid: 200,
  utm_source: 100,
  utm_medium: 100,
  utm_campaign: 150,
  utm_term: 150,
};

/** Letters, digits and the punctuation ad platforms use; anything else is dropped rather than stored. */
const SAFE_VALUE = /^[\w .,:+\-~@{}()[\]|/%]*$/;

function clean(value: string | null | undefined, max: number): string | undefined {
  if (value == null) return undefined;
  const v = value.trim().slice(0, max);
  if (v === "" || !SAFE_VALUE.test(v)) return undefined;
  return v;
}

function cleanPath(path: string | null | undefined): string | undefined {
  if (!path || !path.startsWith("/") || path.startsWith("//")) return undefined;
  return clean(path, 200);
}

/** The source carried by a link, or null when it has no click ID or campaign tags. */
export function sourceFromUrl(url: URL): AdSource | null {
  const out: AdSource = {};
  for (const [key, max] of Object.entries(PARAMS) as [keyof typeof PARAMS, number][]) {
    const v = clean(url.searchParams.get(key), max);
    if (v) out[key] = v;
  }
  if (Object.keys(out).length === 0) return null;
  const landing = cleanPath(url.pathname);
  if (landing) out.landing = landing;
  return out;
}

/** The cookie value for a source. */
export function encodeSource(source: AdSource): string {
  return encodeURIComponent(JSON.stringify(source));
}

/** A source read back from the cookie, keeping only known, clean fields. */
export function decodeSource(raw: string | null | undefined): AdSource | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeURIComponent(raw));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  const out: AdSource = {};
  for (const [key, max] of Object.entries(PARAMS) as [keyof typeof PARAMS, number][]) {
    const v = typeof obj[key] === "string" ? clean(obj[key] as string, max) : undefined;
    if (v) out[key] = v;
  }
  if (Object.keys(out).length === 0) return null;
  const landing = typeof obj.landing === "string" ? cleanPath(obj.landing) : undefined;
  if (landing) out.landing = landing;
  return out;
}

/** One cookie's value from a Cookie header, or null. */
export function readCookie(cookieHeader: string | null | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

/**
 * The Google Analytics client ID from the _ga cookie: "GA1.1.123456789.1700000000"
 * gives "123456789.1700000000". Null when absent or not that shape.
 */
export function gaClientIdFrom(cookieHeader: string | null | undefined): string | null {
  const raw = readCookie(cookieHeader, "_ga");
  if (!raw) return null;
  const parts = raw.split(".");
  if (parts.length < 4) return null;
  const id = parts.slice(-2).join(".");
  return /^\d{1,20}\.\d{1,12}$/.test(id) ? id : null;
}

/**
 * The current Google Analytics session ID from the stream's own cookie,
 * _ga_<ID> for measurement ID G-<ID>. Reads both the older format
 * ("GS1.1.1700000000.3....", third part) and the newer one
 * ("GS2.1.s1700000000$o3$...", after the "s"). Null when absent.
 */
export function gaSessionIdFrom(cookieHeader: string | null | undefined, measurementId: string): string | null {
  const suffix = measurementId.replace(/^G-/, "");
  if (!/^[A-Z0-9]{4,15}$/.test(suffix)) return null;
  const raw = readCookie(cookieHeader, `_ga_${suffix}`);
  if (!raw) return null;
  const parts = raw.split(".");
  if (parts[0] === "GS1" && parts[2] && /^\d{1,12}$/.test(parts[2])) return parts[2];
  const m = /(?:^|\$)s(\d{1,12})(?:\$|$)/.exec(parts.slice(2).join("."));
  return m ? m[1] : null;
}

/** A short label for the admin pages: "Google ad: Campaign / keyword", "newsletter / email", or null. */
export function sourceLabel(s: {
  adGclid?: string | null;
  utmSource?: string | null;
  utmMedium?: string | null;
  utmCampaign?: string | null;
  utmTerm?: string | null;
}): string | null {
  const detail = [s.utmCampaign, s.utmTerm].filter(Boolean).join(" / ");
  if (s.adGclid) return detail ? `Google ad: ${detail}` : "Google ad";
  const from = [s.utmSource, s.utmMedium].filter(Boolean).join(" / ");
  if (!from && !detail) return null;
  return [from, detail].filter(Boolean).join(": ");
}
