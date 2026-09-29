import { NextRequest, NextResponse } from "next/server";
import { ACTIVE_COMPANY_COOKIE, connectionForAccount, getAccount } from "@/lib/account";
import { companyOpenPath, safeDashboardPath } from "@/lib/companyLinks";

export const dynamic = "force-dynamic";

/**
 * GET /api/company/open?company=<connectionId>&next=/dashboard/...
 *
 * What the links in the weekly brief and alert emails go through, so each
 * opens the company the email is about rather than whichever one was last
 * on screen (see src/lib/companyLinks.ts).
 *
 *  - Not signed in: to the login page, which comes back here afterwards.
 *  - A company this login may not see (another account's, a disconnected
 *    one, or for a client login any but its own): to the dashboard as it
 *    is, nothing switched.
 *  - Otherwise: that company becomes the one on screen, then `next`.
 *
 * `next` is only ever a page under /dashboard on this site (safeDashboardPath),
 * so the link can't be turned into a redirect to somewhere else. Like
 * POST /api/company/select, this changes nothing on the account, only which
 * of its own companies this browser shows, and it is scoped by
 * connectionForAccount. So a client login may use it for its one company,
 * which is why there's no refuseClient here.
 */
export async function GET(req: NextRequest) {
  const company = req.nextUrl.searchParams.get("company") ?? "";
  const next = safeDashboardPath(req.nextUrl.searchParams.get("next"));
  const to = (path: string) => {
    const res = NextResponse.redirect(new URL(path, req.nextUrl.origin), 303);
    res.headers.set("Cache-Control", "no-store");
    return res;
  };

  const account = await getAccount();
  if (!account) {
    return to(`/login?next=${encodeURIComponent(companyOpenPath(company, next))}`);
  }

  const connection = await connectionForAccount(account, company);
  if (!connection) return to("/dashboard");

  const res = to(next);
  res.cookies.set(ACTIVE_COMPANY_COOKIE, connection.id, {
    path: "/",
    sameSite: "lax",
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    maxAge: 60 * 60 * 24 * 365,
  });
  return res;
}
