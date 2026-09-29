/**
 * Links in emails that open a page for one particular company.
 *
 * The dashboard shows whichever company was last picked in the company
 * switcher (a cookie). An email about company B that linked straight to
 * /dashboard/settings could land its reader, a firm owner say, on company
 * A's Settings, and they'd change A's brief schedule thinking it was B's.
 * So every such link goes through /api/company/open, which checks this
 * login may see the company, switches to it, and then opens the page.
 */

const OPEN_ROUTE = "/api/company/open";
const FALLBACK = "/dashboard";

/** The path (on this site) that opens `next` with `connectionId` on screen. */
export function companyOpenPath(connectionId: string, next: string): string {
  return `${OPEN_ROUTE}?company=${encodeURIComponent(connectionId)}&next=${encodeURIComponent(next)}`;
}

/**
 * Where /api/company/open may send someone: a page under /dashboard on this
 * site, and nothing else, so the route can't be used to bounce people to
 * another website. The path is resolved the way a browser resolves it
 * (tabs and newlines dropped, backslashes read as slashes, dot segments
 * collapsed) before it is checked, and anything that doesn't pass becomes
 * the dashboard itself.
 */
export function safeDashboardPath(next: string | null | undefined): string {
  if (typeof next !== "string" || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return FALLBACK;
  const base = "https://app.invalid";
  let url: URL;
  try {
    url = new URL(next, base);
  } catch {
    return FALLBACK;
  }
  if (url.origin !== base) return FALLBACK;
  if (url.pathname !== "/dashboard" && !url.pathname.startsWith("/dashboard/")) return FALLBACK;
  const path = url.pathname + url.search + url.hash;
  // A path that still starts with "//" would be read as another site.
  return path.startsWith("//") ? FALLBACK : path;
}
