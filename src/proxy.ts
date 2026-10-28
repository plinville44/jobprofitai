import { NextResponse, type NextRequest } from "next/server";
import { refusesCrossSiteChange } from "@/lib/sameOrigin";

/**
 * Cross-site request forgery protection for every API route that changes
 * something: a POST, PATCH, PUT or DELETE that a browser marks as coming
 * from another site is refused here, before it reaches the route. See
 * refusesCrossSiteChange in src/lib/sameOrigin.ts for the rules and the
 * routes left out.
 */
export function proxy(request: NextRequest) {
  if (refusesCrossSiteChange(request.method, request.nextUrl.pathname, request.headers, request.url)) {
    return NextResponse.json({ error: "Please use the JobProfitAI site to do this." }, { status: 403 });
  }
  return NextResponse.next();
}

// Requests from our own pages (Sec-Fetch-Site: same-origin) can't be
// cross-site, so the proxy isn't run for them at all.
export const config = {
  matcher: [
    {
      source: "/api/:path*",
      missing: [{ type: "header", key: "sec-fetch-site", value: "same-origin" }],
    },
  ],
};
