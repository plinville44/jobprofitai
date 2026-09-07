import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  normalizeCode,
  REFERRAL_COOKIE,
  REFERRAL_COOKIE_MAX_AGE_SECONDS,
} from "@/lib/referrals";

/**
 * GET /r/[code]
 *
 * The public referral landing URL (e.g. jobprofitai.com/r/K7PQ2MX). Records
 * the code in a cookie and sends the visitor to signup.
 *
 * The cookie is httpOnly on purpose: attribution is read server-side during
 * signup, and nothing in the browser needs to see or set it. A client-
 * writable attribution cookie would be trivially forgeable, which matters
 * once it's attached to commission payments.
 *
 * An unknown or inactive code isn't an error the visitor should ever see -
 * they came here to look at the product. It just redirects to signup with no
 * attribution.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, { params }: { params: { code: string } }) {
  const code = normalizeCode(params.code ?? "");
  const signupUrl = new URL("/signup", req.url);

  // Codes are short and fixed-alphabet; anything else is noise or probing.
  if (!/^[A-Z0-9]{4,16}$/.test(code)) {
    return NextResponse.redirect(signupUrl);
  }

  const referralCode = await prisma.referralCode.findUnique({
    where: { code },
    include: { partner: { select: { status: true } } },
  });

  // Only set the cookie for a code that could actually be honoured at
  // signup, so we don't carry a dead code around for 30 days.
  const usable =
    referralCode != null &&
    (referralCode.kind === "customer" || referralCode.partner?.status === "approved");

  if (!usable) {
    return NextResponse.redirect(signupUrl);
  }

  // `ref=1` lets the signup page show a "you were referred" note without
  // exposing the code itself to client-side JavaScript.
  signupUrl.searchParams.set("ref", "1");
  const response = NextResponse.redirect(signupUrl);

  response.cookies.set(REFERRAL_COOKIE, code, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: REFERRAL_COOKIE_MAX_AGE_SECONDS,
  });

  return response;
}
