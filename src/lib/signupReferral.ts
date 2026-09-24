import { cookies } from "next/headers";
import { prisma } from "./prisma";
import { attributeReferral, REFERRAL_COOKIE } from "./referrals";
import { sendPartnerNewSignup, sendReferralSignup } from "./email/lifecycle";

/**
 * Credits a new account to whoever referred it (the referral cookie set by
 * /r/[code]) and tells them. Shared by password signup and Sign in with
 * Intuit. Best-effort: never throws, because nothing secondary gets to
 * break a signup.
 *
 * Returns whether a referral cookie was present, so the caller can clear
 * it on the response. The code is spent by the first account that uses it;
 * left in place it would attribute every later signup from that browser
 * (a contractor setting up a login for their bookkeeper, say) to the same
 * referrer.
 */
export async function attributeSignupReferral(userId: string): Promise<boolean> {
  let hadReferralCookie = false;
  try {
    const cookieStore = await cookies();
    const refCode = cookieStore.get(REFERRAL_COOKIE)?.value ?? null;
    hadReferralCookie = refCode != null;
    const attribution = await attributeReferral(userId, refCode);

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
  return hadReferralCookie;
}
