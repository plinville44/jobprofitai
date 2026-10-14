import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { clientIp, ipKey } from "@/lib/loginThrottle";
import { ACCEPTANCE_VERSION } from "@/lib/legalVersion";

/**
 * Records that a login agreed to the Terms of Service and Privacy Policy, so
 * there's evidence of it (the version, when, how, and a hash of the network
 * address with the browser), and asks again when ACCEPTANCE_VERSION changes.
 *
 * Every way into an account records one:
 *   - signup        the unchecked "I agree" box on the signup form
 *   - intuit_signup the same box when Sign in with Intuit creates an account
 *   - reaccept      /accept-terms, for a login with no record of the current
 *                   version (an App Store signup, an account from before the
 *                   box existed, or a material change)
 *   - checkout      Stripe Checkout's required terms checkbox, from the
 *                   checkout.session.completed webhook
 */
export type AcceptanceMethod = "signup" | "intuit_signup" | "reaccept" | "checkout";

/** The fields of a new acceptance, for a nested create inside another write. */
export function acceptanceData(
  method: AcceptanceMethod,
  headers: Headers | null,
  extra: { stripeCheckoutSessionId?: string } = {}
): Omit<Prisma.TermsAcceptanceUncheckedCreateInput, "userId"> {
  const userAgent = headers?.get("user-agent")?.slice(0, 400) ?? null;
  return {
    version: ACCEPTANCE_VERSION,
    method,
    ipHash: headers ? ipKey(clientIp(headers)) : null,
    userAgent,
    ...(extra.stripeCheckoutSessionId ? { stripeCheckoutSessionId: extra.stripeCheckoutSessionId } : {}),
  };
}

export async function recordAcceptance(
  userId: string,
  method: AcceptanceMethod,
  headers: Headers | null,
  extra: { stripeCheckoutSessionId?: string } = {}
): Promise<void> {
  try {
    await prisma.termsAcceptance.create({ data: { userId, ...acceptanceData(method, headers, extra) } });
  } catch (err) {
    // A webhook delivered twice records the checkout acceptance once.
    if ((err as { code?: string })?.code === "P2002") return;
    throw err;
  }
}

/** Whether this login has agreed to the current version. */
export async function hasAcceptedCurrentTerms(userId: string): Promise<boolean> {
  const found = await prisma.termsAcceptance.findFirst({
    where: { userId, version: ACCEPTANCE_VERSION },
    select: { id: true },
  });
  return found != null;
}

/** Where /accept-terms may send someone back to: only pages inside the app. */
export function safeReturnPath(next: string | null | undefined): string {
  if (!next || !next.startsWith("/") || next.startsWith("//")) return "/dashboard";
  return next.startsWith("/dashboard") || next.startsWith("/reports") ? next : "/dashboard";
}
