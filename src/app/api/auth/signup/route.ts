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
import { acceptanceData } from "@/lib/termsAcceptance";
import { signupAdOptOut } from "@/lib/adOptOut";
import { SOURCE_COOKIE } from "@/lib/adSource";
import { reportServerEvent, signupAdSource, signupSessionId } from "@/lib/serverEvents";
import { claimSignupSlot, clientIp, findLoginByEmail, releaseSignupSlot } from "@/lib/loginThrottle";

export const runtime = "nodejs";

const SignupSchema = z.object({
  email: z.string().email().max(320),
  password: z.string().min(8, "Password must be at least 8 characters").max(200),
  name: z.string().trim().max(120).optional(),
  timeZone: z.string().max(64).optional(),
  // The unchecked "I agree to the Terms of Service and Privacy Policy" box.
  acceptTerms: z.literal(true, {
    error: "Please check the box to agree to the Terms of Service and Privacy Policy.",
  }),
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

  // Every signup mails a verification link to the address typed, so one
  // network address gets a few an hour, or a script could mail anyone. The
  // place is taken before anything slow (the hash, the insert), so signups
  // sent at once can't all get through; one that creates no account gives
  // it back.
  const slot = await claimSignupSlot(clientIp(req.headers));
  if (!slot.ok) {
    return NextResponse.json(
      { error: "Too many accounts have been created from this network in the last hour. Please try again later." },
      { status: 429 }
    );
  }

  // Exact, ignoring case: a wildcard match would wrongly say a different
  // address is taken (findLoginByEmail).
  const existing = await findLoginByEmail(email);
  if (existing) {
    await releaseSignupSlot(slot.slotId);
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
        // The acceptance is written with the account, so no account exists
        // without a record of agreeing.
        termsAcceptances: { create: acceptanceData("signup", req.headers) },
        // An opt-out made before signing up (Global Privacy Control, or Your
        // Privacy Choices in this browser) carries over to the account.
        ...signupAdOptOut(req),
        // Where they came from and the analytics browser ID, only when the
        // request carries no opt-out (src/lib/serverEvents.ts).
        ...signupAdSource(req.headers),
      },
    });
  } catch (err) {
    await releaseSignupSlot(slot.slotId);
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

  // The signup itself, reported from here because the browser leaves the
  // signup page for the app straight away. Skipped for an opted-out account.
  await reportServerEvent(user.id, "sign_up", { method: "email" }, { sessionId: signupSessionId(req.headers) });

  const response = NextResponse.json({ id: user.id, email: user.email });
  // Copied onto the account above, so the browser doesn't need it any more.
  response.cookies.set(SOURCE_COOKIE, "", { path: "/", maxAge: 0 });
  if (hadReferralCookie) {
    // Deleted with the same path the /r/[code] route set it on, or the
    // browser keeps a second copy scoped elsewhere and nothing changes.
    response.cookies.set(REFERRAL_COOKIE, "", { path: "/", maxAge: 0 });
  }
  return response;
}
