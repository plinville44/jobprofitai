import { NextRequest, NextResponse } from "next/server";
import { SignJWT } from "jose";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { buildAuthorizeUrl } from "@/lib/quickbooks";
import { canConnectAnotherCompany } from "@/lib/entitlements";

/**
 * GET /api/quickbooks/connect
 * The "Connect to QuickBooks" button hits this route, which redirects the
 * user to Intuit's own login/consent screen. Nothing about the user's
 * QuickBooks credentials ever passes through our servers - that's the point
 * of OAuth. We just get a `code` back on /api/quickbooks/callback afterward.
 */
export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.redirect(new URL("/login", process.env.APP_URL));
  }

  // Reconnecting a company this account already has is not connecting
  // another one. Without this path a $149 account whose token Intuit had
  // revoked was told "your plan covers 1 company and you've already
  // connected 1", because the dead connection still counts, and the only way
  // out was to disconnect first. The callback keeps the count honest if a
  // different company is chosen on Intuit's screen (see there).
  const reconnectId = new URL(req.url).searchParams.get("reconnect");
  const reconnecting = reconnectId
    ? await prisma.quickBooksConnection.findFirst({
        where: { id: reconnectId, userId: session.userId, disconnectedAt: null },
        select: { id: true },
      })
    : null;

  // Plan limits are enforced HERE, before the user is ever sent to Intuit.
  // Letting someone complete an OAuth consent screen and only then telling
  // them their plan doesn't cover a second company would be a poor
  // experience, and refusing after the fact is harder to do cleanly. This is
  // a server-side check - hiding the button would not be one.
  const permission = reconnecting ? null : await canConnectAnotherCompany(session.userId);
  if (permission && !permission.allowed) {
    return NextResponse.redirect(
      new URL(
        `/dashboard/billing?limit=${encodeURIComponent(permission.reason ?? "plan_limit")}`,
        process.env.APP_URL
      )
    );
  }

  // Short-lived signed state token: proves the callback belongs to this login
  // session (CSRF protection) and survives the round trip to Intuit and back.
  const state = await new SignJWT({ userId: session.userId, ...(reconnecting ? { reconnect: reconnecting.id } : {}) })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(new TextEncoder().encode(process.env.AUTH_SECRET));

  return NextResponse.redirect(await buildAuthorizeUrl(state));
}
