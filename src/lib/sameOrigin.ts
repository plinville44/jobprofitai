import { NextResponse } from "next/server";

/**
 * Guards the routes that START a session (log in, sign up, accept an
 * invitation, finish Sign in with Intuit) against login CSRF: another site
 * submitting a form that signs the visitor into the attacker's account,
 * then steering them to connect their QuickBooks company to it.
 *
 * The session cookie's SameSite setting protects routes that need an
 * existing session; it can't protect these, which need none. So:
 *   - a browser that says the request came from another site is refused
 *     (Sec-Fetch-Site, or Origin when that header is missing);
 *   - the body must be JSON, which a plain cross-site form can't send.
 *
 * Returns a response to send back when the request should be refused.
 */
export function refuseCrossSite(req: Request, opts: { requireJson?: boolean } = { requireJson: true }): NextResponse | null {
  const site = req.headers.get("sec-fetch-site");
  let crossSite = false;
  if (site) {
    crossSite = site !== "same-origin" && site !== "none";
  } else {
    const origin = req.headers.get("origin");
    const app = process.env.APP_URL ? safeOrigin(process.env.APP_URL) : null;
    crossSite = origin != null && app != null && origin !== app;
  }
  if (crossSite) return NextResponse.json({ error: "Please use the JobProfitAI site to do this." }, { status: 403 });
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
