import { NextRequest, NextResponse } from "next/server";
import { SignJWT } from "jose";
import { prisma } from "@/lib/prisma";
import { getAccount } from "@/lib/account";
import { buildAuthorizeUrl } from "@/lib/quickbooks";
import { canConnectAnotherCompany, getEntitlements } from "@/lib/entitlements";
import { connectNeedsOwner, OWNER_ONLY_CONNECT_NOTICE } from "@/lib/connectCompany";

/**
 * GET /api/quickbooks/connect[?reconnect=<connectionId>]
 *
 * The "Connect to QuickBooks" button hits this route, which redirects to
 * Intuit's own sign-in and consent screen. QuickBooks credentials never
 * pass through our servers; we get a one-time code back on the callback.
 *
 * Works for the account owner and for team members; the company always
 * belongs to the account owner. On a paid Firm plan only the owner can add a
 * new company, since each one changes the bill; members can still reconnect.
 */
export async function GET(req: NextRequest) {
  const account = await getAccount();
  if (!account) {
    return NextResponse.redirect(new URL("/login?next=/dashboard", process.env.APP_URL));
  }
  // A client's view-only login can't add companies to the firm's account.
  if (account.role === "client") {
    return NextResponse.redirect(new URL("/dashboard?qbo_error=view_only", process.env.APP_URL));
  }

  // Reconnecting a company this account already has is not connecting
  // another one, so it skips the plan's company limit. The callback keeps
  // the count honest if a different company is chosen on Intuit's screen.
  const reconnectId = new URL(req.url).searchParams.get("reconnect");
  const reconnecting = reconnectId
    ? await prisma.quickBooksConnection.findFirst({
        where: { id: reconnectId, userId: account.ownerId, disconnectedAt: null },
        select: { id: true },
      })
    : null;

  // On a paid Firm plan a new company is added to the bill, so only the
  // owner may connect one (checked again in the callback).
  if (!reconnecting && account.role === "member" && connectNeedsOwner(await getEntitlements(account.ownerId))) {
    return NextResponse.redirect(
      new URL(`/dashboard/settings?notice=${OWNER_ONLY_CONNECT_NOTICE}`, process.env.APP_URL)
    );
  }

  // Plan limits are enforced here, before anyone is sent to Intuit, and
  // again in the callback (two tabs could both get this far).
  const permission = reconnecting ? null : await canConnectAnotherCompany(account.ownerId);
  if (permission && !permission.allowed) {
    return NextResponse.redirect(
      new URL("/dashboard/billing?limit=plan_limit", process.env.APP_URL)
    );
  }

  // Short-lived signed state. The callback only accepts it back in the same
  // signed-in browser session that started it (actorId must match the
  // session there), which is what stops someone else's link from attaching
  // a company to the wrong account.
  const state = await new SignJWT({
    flow: "connect",
    actorId: account.userId,
    ownerId: account.ownerId,
    ...(reconnecting ? { reconnect: reconnecting.id } : {}),
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(new TextEncoder().encode(process.env.AUTH_SECRET));

  return NextResponse.redirect(await buildAuthorizeUrl(state));
}
