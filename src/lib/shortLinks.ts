/**
 * Short links for outreach emails: jobprofitai.com/go/<slug>.
 *
 * Cold emails go out as plain text, so the link is shown in full. A short
 * link reads like one person writing; the long tagged address reads like
 * tracking. Each slug forwards to the page with the same utm_ tags the long
 * links carried (source=email, medium=outreach, plus the campaign), so GA4
 * still credits the visit and any signup to the right outreach campaign.
 *
 * Every target is a path on this site, never another host, so /go can't be
 * used to bounce someone to another website. An unknown slug goes to the
 * homepage, still tagged as outreach, rather than showing an error.
 *
 * To add or change a link: edit SHORT_LINKS and update the Links and
 * tracking section of the Weekly Outreach Routine doc to match.
 */

const OUTREACH = "utm_source=email&utm_medium=outreach";

const tagged = (path: string, campaign: string, hash = "") =>
  `${path}?${OUTREACH}&utm_campaign=${campaign}${hash}`;

export const SHORT_LINKS: Readonly<Record<string, string>> = {
  // A Owners
  demo: tagged("/demo", "owners"),
  check: tagged("/", "owners", "#fit-check"),
  // B Office
  sample: tagged("/demo", "office"),
  trial: tagged("/signup", "office"),
  // C Bookkeepers
  example: tagged("/demo", "bookkeepers"),
  partners: tagged("/partners", "bookkeepers"),
};

export const SHORT_LINK_FALLBACK = `/?${OUTREACH}`;

/** The on-site path (with tags) that /go/<slug> forwards to. */
export function shortLinkTarget(slug: string | undefined | null): string {
  const key = (slug ?? "").trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(SHORT_LINKS, key) ? SHORT_LINKS[key] : SHORT_LINK_FALLBACK;
}
