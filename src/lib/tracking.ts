/**
 * The rules for the marketing tags: Google Tag Manager, and through it Google
 * Analytics, whose measurements also count as Google Ads conversions. The
 * Privacy Policy (section 2), the Your Privacy Choices page and the Security
 * page promise exactly these rules, so change them together and keep the
 * tests passing.
 *
 * - The tags run only on the public pages listed below and the signup page.
 *   Never in the signed-in app (dashboard, job pages, reports, settings,
 *   billing, admin), where QuickBooks figures, jobs and customers are on
 *   screen, and never on the login, password or invitation pages.
 * - They don't load at all when the browser sends Global Privacy Control, or
 *   when the visitor has turned them off on /privacy-choices (the
 *   jpai_optout cookie).
 * - For visitors in the EEA, the UK and Switzerland, Google Consent Mode
 *   starts with everything "denied", so Google's tags set no cookies there.
 * - No remarketing, no enhanced conversions and no LinkedIn Insight Tag at
 *   launch: the Privacy Policy says so. Adding any of them means adding its
 *   paragraph to the policy first.
 *
 * Our own jpai_src cookie (src/lib/adSource.ts) follows the same rules (and
 * isn't set or kept for the EEA, UK and Switzerland either), and steps
 * reported from the server (src/lib/serverEvents.ts) check the account's
 * choice with serverReportsAllowed().
 *
 * Nothing here runs until NEXT_PUBLIC_GTM_ID is set in Vercel (jpai_src is
 * set either way).
 */

/** Pages where the tags may run. Add a new public page here on purpose, or leave it out on purpose. */
export const TAGGED_PATHS = [
  "/",
  "/how-it-works",
  "/pricing",
  "/demo",
  "/security",
  "/partners",
  "/contact",
  "/privacy",
  "/terms",
  "/dpa",
  "/privacy-choices",
  "/signup",
] as const;

/** The ad landing pages. */
export const TAGGED_PREFIXES = ["/lp/"] as const;

export function tagsAllowedOnPath(pathname: string): boolean {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  if ((TAGGED_PATHS as readonly string[]).includes(path)) return true;
  return TAGGED_PREFIXES.some((prefix) => path.startsWith(prefix));
}

/** Set by the Your Privacy Choices page when a visitor turns the tags off. */
export const OPT_OUT_COOKIE = "jpai_optout";
/** About 13 months: browsers cap a cookie's lifetime at 400 days. */
export const OPT_OUT_MAX_AGE_SECONDS = 400 * 24 * 60 * 60;

export function optedOutByCookie(cookieHeader: string): boolean {
  return cookieHeader.split(";").some((part) => part.trim() === `${OPT_OUT_COOKIE}=1`);
}

/** True when the browser sends a Global Privacy Control signal (navigator.globalPrivacyControl). */
export function gpcOn(nav: { globalPrivacyControl?: unknown } | undefined): boolean {
  return nav?.globalPrivacyControl === true;
}

/** The one check every marketing measurement makes before it runs. */
export function trackingAllowed({ gpc, cookieHeader }: { gpc: boolean; cookieHeader: string }): boolean {
  return !gpc && !optedOutByCookie(cookieHeader);
}

/**
 * First-party cookies the tags (or our attribution cookie) may have set on
 * this site, cleared when a visitor opts out. Google's own cookies on its
 * domains can only be cleared from Google's sites. (LinkedIn's names stay in
 * the list in case its tag is added later.)
 */
const MARKETING_COOKIE_NAME = /^(_ga|_gid|_gcl_|_gac_|jpai_src$|_?li_|AnalyticsSyncHistory$|UserMatchHistory$)/;

export function marketingCookieNames(cookieHeader: string): string[] {
  return cookieHeader
    .split(";")
    .map((part) => part.split("=")[0].trim())
    .filter((name) => name !== "" && MARKETING_COOKIE_NAME.test(name));
}

/** "app.jobprofitai.com" -> ["app.jobprofitai.com", "jobprofitai.com"], the domains a cookie could be set on. */
export function cookieDomainsFor(hostname: string): string[] {
  const parts = hostname.split(".");
  if (parts.length < 2) return [hostname];
  const domains: string[] = [];
  for (let i = 0; i <= parts.length - 2; i++) domains.push(parts.slice(i).join("."));
  return domains;
}

/** EEA (EU, Iceland, Liechtenstein, Norway), the UK and Switzerland, as Consent Mode region codes. */
export const CONSENT_DENIED_REGIONS = [
  "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE", "IT",
  "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE",
  "IS", "LI", "NO",
  "GB", "CH",
] as const;

/**
 * Whether a request comes from the EEA, the UK or Switzerland, by the
 * country Vercel adds to every request (x-vercel-ip-country). Where these
 * regions get Consent Mode "denied", we also keep no record of which ad or
 * link brought someone (src/lib/serverEvents.ts).
 */
export function fromConsentRegion(headers: Headers): boolean {
  const country = headers.get("x-vercel-ip-country")?.trim().toUpperCase() ?? "";
  return (CONSENT_DENIED_REGIONS as readonly string[]).includes(country);
}

/**
 * Zones outside "Europe/" that are in the EEA: Iceland, Cyprus, the Canary
 * Islands, Madeira, the Azores, Ceuta, Svalbard and France's overseas
 * regions and collectivities in the EU.
 */
const EEA_ZONES_OUTSIDE_EUROPE = new Set([
  "Atlantic/Reykjavik",
  "Asia/Nicosia",
  "Asia/Famagusta",
  "Atlantic/Canary",
  "Atlantic/Madeira",
  "Atlantic/Azores",
  "Africa/Ceuta",
  "Arctic/Longyearbyen",
  "Indian/Reunion",
  "Indian/Mayotte",
  "America/Martinique",
  "America/Guadeloupe",
  "America/Cayenne",
  "America/Marigot",
  "America/St_Barthelemy",
]);

/**
 * The browser-side version: a European time zone. Used only to skip our
 * jpai_src cookie, so it errs toward skipping.
 */
export function europeanTimeZone(timeZone: string | undefined): boolean {
  return typeof timeZone === "string" && (timeZone.startsWith("Europe/") || EEA_ZONES_OUTSIDE_EUROPE.has(timeZone));
}

export const GTM_ID_PATTERN = /^GTM-[A-Z0-9]{4,12}$/;

/**
 * The inline script that sets the Consent Mode defaults and then loads GTM.
 * The defaults must come first, before any tag reads them. Returns null for a
 * missing or malformed container ID, so nothing is injected.
 */
export function gtmBootstrap(gtmId: string): string | null {
  if (!GTM_ID_PATTERN.test(gtmId)) return null;
  const denied = "ad_storage:'denied',ad_user_data:'denied',ad_personalization:'denied',analytics_storage:'denied'";
  // Everywhere else measurement is on, but ad personalization (remarketing,
  // audiences) stays denied: the Privacy Policy says we don't use it.
  const usual = "ad_storage:'granted',ad_user_data:'granted',ad_personalization:'denied',analytics_storage:'granted'";
  const regions = CONSENT_DENIED_REGIONS.map((r) => `'${r}'`).join(",");
  return [
    "window.dataLayer=window.dataLayer||[];",
    "function gtag(){dataLayer.push(arguments);}",
    `gtag('consent','default',{${denied},region:[${regions}]});`,
    `gtag('consent','default',{${usual}});`,
    "(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':new Date().getTime(),event:'gtm.js'});",
    "var f=d.getElementsByTagName(s)[0],j=d.createElement(s);j.async=true;",
    "j.src='https://www.googletagmanager.com/gtm.js?id='+i;f.parentNode.insertBefore(j,f);",
    `})(window,document,'script','dataLayer','${gtmId}');`,
  ].join("");
}

/**
 * Whether anything may be reported to Google from the server about this
 * account (src/lib/serverEvents.ts). False once
 * the person has opted out on the account, however they did it
 * (src/lib/adOptOut.ts). Every server-side report must check this first,
 * including ones queued or sent later, such as a renewal.
 */
export function serverReportsAllowed(user: { adOptOutAt: Date | null }): boolean {
  return user.adOptOutAt == null;
}

/**
 * Whether moving from the current page to `target` takes the visitor out of
 * the tagged pages (into the app, login and so on). Once the tags are
 * loaded, such a move must be a full page load, never an in-page one:
 * Next.js renders the next page before it updates the address, and the
 * tags' history listeners would report it. Other sites are left alone.
 */
export function leavesTaggedPages(currentHref: string, target: string | URL | null | undefined): boolean {
  if (target == null || target === "") return false;
  let next: URL;
  try {
    next = new URL(String(target), currentHref);
  } catch {
    return false;
  }
  if (next.origin !== new URL(currentHref).origin) return false;
  return !tagsAllowedOnPath(next.pathname);
}
