import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { createBillingPortalSession } from "@/lib/stripe/billing";

/**
 * POST /api/billing/portal
 *
 * Opens the Stripe-hosted Billing Portal, where the customer can update
 * their card, download invoices, switch plans and cancel. Using Stripe's
 * portal is what makes "cancel anytime" a genuine self-serve capability
 * rather than an email request, and it keeps card data entirely off our
 * infrastructure.
 */
export const runtime = "nodejs";

export async function POST() {
  try {
    const session = await getSession();
    if (!session) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

    // The portal is only meaningful for someone who has actually been
    // through checkout. Sending a trial user there produces a confusing
    // empty portal, so send them to plan selection instead.
    const subscription = await prisma.subscription.findUnique({
      where: { userId: session.userId },
      select: { stripeCustomerId: true },
    });
    if (!subscription?.stripeCustomerId) {
      return NextResponse.json(
        { error: "You don't have a subscription to manage yet. Choose a plan to get started." },
        { status: 400 }
      );
    }

    const url = await createBillingPortalSession(session.userId);
    return NextResponse.json({ url });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("billing/portal failed:", message);

    // Stripe requires the Billing Portal to be configured once per account
    // (Settings -> Billing -> Customer portal). Until it is, the API returns
    // a specific error that's worth translating for the operator.
    const needsPortalConfig = message.toLowerCase().includes("portal");
    return NextResponse.json(
      {
        error: needsPortalConfig
          ? "The billing portal isn't configured yet. Please contact support@jobprofitai.com."
          : "We couldn't open your billing portal. Please try again, or contact support@jobprofitai.com.",
      },
      { status: 500 }
    );
  }
}
