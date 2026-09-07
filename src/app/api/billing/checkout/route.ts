import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { isPlanId } from "@/lib/plans";
import { createCheckoutSession } from "@/lib/stripe/billing";

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
    const session = await getSession();
    if (!session) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const plan = body?.plan;

    if (!isPlanId(plan)) {
      return NextResponse.json({ error: "Choose a valid plan." }, { status: 400 });
    }

    const { url } = await createCheckoutSession(session.userId, plan);
    return NextResponse.json({ url });
  } catch (err) {
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
