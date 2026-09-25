import { NextRequest, NextResponse } from "next/server";
import { refuseCrossSite } from "@/lib/sameOrigin";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { hashPassword, createSession } from "@/lib/auth";
import { newTrialSubscriptionData } from "@/lib/trial";
import { REFERRAL_COOKIE } from "@/lib/referrals";
import { attributeSignupReferral } from "@/lib/signupReferral";
import { sendEmailVerification } from "@/lib/email/lifecycle";
import { createEmailVerification, VERIFY_TOKEN_TTL_HOURS } from "@/lib/emailVerification";

export const runtime = "nodejs";

const SignupSchema = z.object({
  email: z.string().email().max(320),
  password: z.string().min(8, "Password must be at least 8 characters").max(200),
  name: z.string().trim().max(120).optional(),
  timeZone: z.string().max(64).optional(),
});

/** A real IANA zone name, or null. */
function validTimeZone(tz: string | undefined): string | null {
  if (!tz) return null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return null;
  }
}

/**
 * POST /api/auth/signup
 *
 * Creates the account and its 14-day free trial in a single transaction, so
 * an account can never exist without a trial row. No credit card, no Stripe
 * object, no payment method - none of that exists until the customer chooses
 * a plan later.
 *
 * Referral attribution, the verification email and referrer notifications all run
 * AFTER the account is committed and are individually fault-tolerant: none
 * of them can fail a signup. Someone creating an account is the single most
 * valuable thing that happens in this app, and nothing secondary gets to
 * break it.
 */
export async function POST(req: NextRequest) {
  const refused = refuseCrossSite(req);
  if (refused) return refused;
  const body = await req.json().catch(() => ({}));
  const parsed = SignupSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const { password, name } = parsed.data;
  const timeZone = validTimeZone(parsed.data.timeZone);
  // New accounts store a normalized address so "Sam@x.com" and "sam@x.com"
  // can't become two accounts. Existing rows are left exactly as they are -
  // login handles both (see the login route).
  const email = parsed.data.email.trim().toLowerCase();

  const existing = await prisma.user.findFirst({
    where: { email: { equals: email, mode: "insensitive" } },
    select: { id: true },
  });
  if (existing) {
    return NextResponse.json(
      { error: "An account with that email already exists." },
      { status: 409 }
    );
  }

  const passwordHash = await hashPassword(password);

  let user;
  try {
    user = await prisma.user.create({
      data: {
        email,
        passwordHash,
        name: name || null,
        timeZone,
        subscription: { create: newTrialSubscriptionData() },
      },
    });
  } catch (err) {
    if ((err as { code?: string })?.code === "P2002") {
      return NextResponse.json(
        { error: "An account with that email already exists." },
        { status: 409 }
      );
    }
    console.error("signup failed:", err instanceof Error ? err.message : "Unknown error");
    return NextResponse.json({ error: "Couldn't create your account. Please try again." }, { status: 500 });
  }

  await createSession(user.id);

  // --- Everything below is best-effort and never fails the signup ---

  // Referral credit and the referrer's notice. The cookie is cleared on the
  // way out whatever attribution decided (see attributeSignupReferral).
  const hadReferralCookie = await attributeSignupReferral(user.id);

  // The verification link, not the welcome. The welcome now goes out once
  // the address is confirmed (see src/app/verify-email/page.tsx), so a new
  // account gets one email at signup instead of two in the same second, and
  // the one it gets is the one that has to be acted on.
  try {
    const created = await createEmailVerification(user.id);
    if (created.ok) {
      const sent = await sendEmailVerification({
        ...created.verification,
        expiryHours: VERIFY_TOKEN_TTL_HOURS,
      });
      if (!sent.ok && !sent.skipped) {
        console.error(`signup: verification email failed for user ${user.id}: ${sent.error}`);
      }
    }
  } catch (err) {
    console.error(
      "signup: verification email failed:",
      err instanceof Error ? err.message : "Unknown error"
    );
  }

  const response = NextResponse.json({ id: user.id, email: user.email });
  if (hadReferralCookie) {
    // Deleted with the same path the /r/[code] route set it on, or the
    // browser keeps a second copy scoped elsewhere and nothing changes.
    response.cookies.set(REFERRAL_COOKIE, "", { path: "/", maxAge: 0 });
  }
  return response;
}
