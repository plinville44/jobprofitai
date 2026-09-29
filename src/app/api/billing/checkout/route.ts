import { NextRequest, NextResponse } from "next/server";
import { getAccount, refuseClient } from "@/lib/account";
import { PLANS, isPlanId } from "@/lib/plans";
import { prisma } from "@/lib/prisma";
import { CheckoutBlockedError, createCheckoutSession } from "@/lib/stripe/billing";
import { getEntitlements } from "@/lib/entitlements";

/**
 * POST /api/billing/checkout  { plan: "profit_intelligence" | "profit_intelligence_pro" }
 *
 * Returns a Stripe-hosted Checkout URL for the client to redirect to. The
 * plan is validated against the plan catalog server-side - the client cannot
 * name an arbitrary Stripe price, so there's no way to check out at a price
 * we don't sell.
 */
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    const account = await getAccount();
    if (!account) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    const refused = refuseClient(account);
    if (refused) return refused;
    if (account.role !== "owner") {
      return NextResponse.json({ error: "Only the account owner can change the plan." }, { status: 403 });
    }

    const body = await req.json().catch(() => ({}));
    const plan = body?.plan;

    if (!isPlanId(plan)) {
      return NextResponse.json({ error: "Choose a valid plan." }, { status: 400 });
    }

    // One subscription per account. The Billing page hides these buttons
    // from paying customers; this is the server-side rule behind that.
    // Our own row only learns of a payment from Stripe's webhook, so
    // createCheckoutSession also asks Stripe (a checkout paid moments ago in
    // another tab), and the webhook cancels and refunds a second
    // subscription that still gets through.
    const entitlements = await getEntitlements(account.ownerId);
    if (entitlements.access === "complimentary") {
      return NextResponse.json(
        { error: "This login has complimentary access to every feature, so there's nothing to buy." },
        { status: 409 }
      );
    }
    if (entitlements.access === "active" || entitlements.access === "past_due") {
      return NextResponse.json(
        { error: "You already have a subscription. Use Manage Billing to switch plans." },
        { status: 409 }
      );
    }

    // A plan must cover the companies already connected. Without this, an
    // account that connected dozens of companies on Firm could cancel and
    // resubscribe to a one-company plan and keep them all. (Companies
    // connected after checkout starts are paused instead, see planLimits.ts.)
    const connected = await prisma.quickBooksConnection.count({ where: { userId: account.ownerId, disconnectedAt: null } });
    const max = PLANS[plan].limits.maxConnections;
    if (connected > max) {
      return NextResponse.json(
        {
          error: `You have ${connected} QuickBooks companies connected and ${PLANS[plan].name} covers ${max}. Disconnect some in Settings first, or choose a plan that covers them all.`,
        },
        { status: 409 }
      );
    }

    const { url } = await createCheckoutSession(account.ownerId, plan);
    return NextResponse.json({ url });
  } catch (err) {
    if (err instanceof CheckoutBlockedError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("billing/checkout failed:", message);

    // Missing configuration is an operator problem, not a customer one -
    // say so plainly rather than showing a card error.
    const notConfigured = message.includes("is not set");
    return NextResponse.json(
      {
        error: notConfigured
          ? "Billing isn't fully configured yet. Please contact support@jobprofitai.com."
          : "We couldn't start checkout. Please try again, or contact support@jobprofitai.com.",
      },
      { status: notConfigured ? 503 : 500 }
    );
  }
}
