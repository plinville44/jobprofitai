import { NextResponse } from "next/server";

/**
 * Whether a browser says this request came from another site.
 *
 * Modern browsers send Sec-Fetch-Site on every request; anything but
 * "same-origin" (our own pages) or "none" (typed into the address bar, a
 * bookmark, a link from an email client) counts as another site. Older
 * browsers don't send it, but do send Origin on a cross-site POST, so then
 * an Origin that isn't one of ours counts ("null" included). A request with
 * neither header isn't from a browser page at all (Stripe's webhook, a mail
 * provider's one-click unsubscribe), and a forged cross-site request in a
 * browser can't leave both out.
 */
export function isCrossSite(headers: Headers, ownOrigins: (string | null | undefined)[]): boolean {
  const site = headers.get("sec-fetch-site");
  if (site) return site !== "same-origin" && site !== "none";
  const origin = headers.get("origin");
  if (origin == null) return false;
  return !ownOrigins.some((o) => o != null && o === origin);
}

/** The origins that are this app: APP_URL's, and the address the request came in on. */
export function appOrigins(requestUrl: string): string[] {
  return [process.env.APP_URL ? safeOrigin(process.env.APP_URL) : null, safeOrigin(requestUrl)].filter(
    (o): o is string => o != null
  );
}

const READ_ONLY = new Set(["GET", "HEAD", "OPTIONS"]);
// Called by other servers, not browsers: Stripe's webhook, the scheduled
// jobs, and the one-click POST a reader's mail provider sends for the two
// unsubscribe links. The unsubscribe pages also post their own forms, and
// because those pages send no Referer, a browser too old to send
// Sec-Fetch-Site (Safari before 16.4) sends "Origin: null" with them; the
// exemption is what lets those readers unsubscribe. The signed link in the
// URL is their protection, not the origin.
const EXEMPT_EXACT = new Set(["/api/stripe/webhook", "/api/brief/unsubscribe", "/api/email/tips-off"]);
const EXEMPT_PREFIX = ["/api/cron/"];

/**
 * Cross-site request forgery protection for every API route that changes
 * something, run by src/proxy.ts before the route.
 *
 * The session cookie is SameSite=Lax, so a browser doesn't attach it to a
 * POST from another site. This is the check Intuit's security review looks
 * for on top of that: a POST, PATCH, PUT or DELETE that a browser marks as
 * coming from another site is refused. Reading (GET, HEAD, OPTIONS) is never
 * refused here.
 */
export function refusesCrossSiteChange(method: string, pathname: string, headers: Headers, requestUrl: string): boolean {
  if (READ_ONLY.has(method.toUpperCase())) return false;
  if (EXEMPT_EXACT.has(pathname) || EXEMPT_PREFIX.some((p) => pathname.startsWith(p))) return false;
  return isCrossSite(headers, appOrigins(requestUrl));
}

/**
 * Guards the routes that START a session (log in, sign up, accept an
 * invitation, finish Sign in with Intuit) against login CSRF: another site
 * submitting a form that signs the visitor into the attacker's account,
 * then steering them to connect their QuickBooks company to it.
 *
 * Every other state-changing API request is checked the same way by
 * src/proxy.ts, on top of the session cookie's SameSite setting. These
 * routes also insist on a JSON body, which a plain cross-site form can't
 * send.
 *
 * Returns a response to send back when the request should be refused.
 */
export function refuseCrossSite(req: Request, opts: { requireJson?: boolean } = { requireJson: true }): NextResponse | null {
  if (isCrossSite(req.headers, appOrigins(req.url))) {
    return NextResponse.json({ error: "Please use the JobProfitAI site to do this." }, { status: 403 });
  }
  if (opts.requireJson !== false && !(req.headers.get("content-type") ?? "").toLowerCase().includes("application/json")) {
    return NextResponse.json({ error: "Invalid request." }, { status: 415 });
  }
  return null;
}

function safeOrigin(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}
