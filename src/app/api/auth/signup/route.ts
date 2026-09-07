import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { hashPassword, createSession } from "@/lib/auth";
import { newTrialSubscriptionData } from "@/lib/trial";
import { attributeReferral, REFERRAL_COOKIE } from "@/lib/referrals";
import { sendPartnerNewSignup, sendReferralSignup, sendTrialWelcome } from "@/lib/email/lifecycle";

export const runtime = "nodejs";

const SignupSchema = z.object({
  email: z.string().email().max(320),
  password: z.string().min(8, "Password must be at least 8 characters").max(200),
  name: z.string().trim().max(120).optional(),
});

/**
 * POST /api/auth/signup
 *
 * Creates the account and its 14-day free trial in a single transaction, so
 * an account can never exist without a trial row. No credit card, no Stripe
 * object, no payment method - none of that exists until the customer chooses
 * a plan later.
 *
 * Referral attribution, the welcome email and referrer notifications all run
 * AFTER the account is committed and are individually fault-tolerant: none
 * of them can fail a signup. Someone creating an account is the single most
 * valuable thing that happens in this app, and nothing secondary gets to
 * break it.
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const parsed = SignupSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const { password, name } = parsed.data;
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

  try {
    const refCode = cookies().get(REFERRAL_COOKIE)?.value ?? null;
    const attribution = await attributeReferral(user.id, refCode);

    if (attribution.attributed) {
      const referral = attribution.referral;
      if (referral.kind === "customer" && referral.referrerUserId) {
        await sendReferralSignup(referral.referrerUserId, referral.id);
      } else if (referral.kind === "partner" && referral.partnerId) {
        const partner = await prisma.partner.findUnique({
          where: { id: referral.partnerId },
          select: { userId: true },
        });
        if (partner) await sendPartnerNewSignup(partner.userId, referral.id);
      }
    }
  } catch (err) {
    console.error(
      "signup: referral attribution/notification failed:",
      err instanceof Error ? err.message : "Unknown error"
    );
  }

  try {
    await sendTrialWelcome(user.id);
  } catch (err) {
    console.error(
      "signup: welcome email failed:",
      err instanceof Error ? err.message : "Unknown error"
    );
  }

  return NextResponse.json({ id: user.id, email: user.email });
}
