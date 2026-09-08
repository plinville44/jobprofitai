import { describe, it, expect, beforeEach, vi } from "vitest";

// The Stripe SDK is never constructed in these tests - only pure helpers from
// the billing module are exercised - but the module imports it at the top, so
// a light stand-in keeps the import graph resolvable without a network client.
vi.mock("stripe", () => ({ default: class {} }));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));

import { subscriptionRevenueCents } from "../stripe/billing";
import { planForPriceId, priceIdForPlan, isStripeConfigured } from "../stripe/client";

/** Builds an invoice in the shape the webhook handler receives. */
function invoice(opts: {
  lines: { type: string; amount: number }[];
  amountPaid: number;
}) {
  return {
    lines: {
      data: opts.lines.map((l) => ({
        type: l.type,
        amount: l.amount,
        price: { type: l.type === "subscription" ? "recurring" : "one_time" },
      })),
    },
    amount_paid: opts.amountPaid,
  } as never;
}

describe("subscription revenue used for commission", () => {
  it("uses the pre-tax subscription line total", () => {
    // $149 subscription + $12 sales tax collected.
    const result = subscriptionRevenueCents(
      invoice({ lines: [{ type: "subscription", amount: 14_900 }], amountPaid: 16_100 })
    );
    expect(result).toBe(14_900);
  });

  it("ignores non-subscription line items", () => {
    const result = subscriptionRevenueCents(
      invoice({
        lines: [
          { type: "subscription", amount: 14_900 },
          { type: "invoiceitem", amount: 5_000 },
        ],
        amountPaid: 19_900,
      })
    );
    expect(result).toBe(14_900);
  });

  /**
   * An invoice largely covered by a referral credit must not generate
   * commission on money that was never collected.
   */
  it("caps at what was actually paid when a credit was applied", () => {
    const result = subscriptionRevenueCents(
      invoice({ lines: [{ type: "subscription", amount: 14_900 }], amountPaid: 4_900 })
    );
    expect(result).toBe(4_900);
  });

  /**
   * Stripe's 2025 API versions removed `type` from invoice lines and replaced
   * `price` with `pricing`, moving the subscription link to
   * `parent.subscription_item_details`. New accounts cannot select an older
   * version, so this is the shape production actually receives.
   *
   * Miss it and nothing errors: the filter matches no lines, the total is 0,
   * and every partner commission is calculated as 20% of nothing.
   */
  it("recognises subscription lines in the newer invoice shape", () => {
    const result = subscriptionRevenueCents({
      lines: {
        data: [
          {
            amount: 14_900,
            parent: {
              type: "subscription_item_details",
              subscription_item_details: { subscription: "sub_abc" },
            },
            pricing: { type: "price_details", price_details: { price: "price_149" } },
          },
        ],
      },
      amount_paid: 14_900,
    } as never);

    expect(result).toBe(14_900);
  });

  it("still ignores one-off lines in the newer invoice shape", () => {
    const result = subscriptionRevenueCents({
      lines: {
        data: [
          {
            amount: 14_900,
            parent: {
              type: "subscription_item_details",
              subscription_item_details: { subscription: "sub_abc" },
            },
          },
          // A manual invoice item: no subscription parent, so not commissionable.
          { amount: 5_000, parent: { type: "invoice_item_details" } },
        ],
      },
      amount_paid: 19_900,
    } as never);

    expect(result).toBe(14_900);
  });

  it("returns zero for an invoice fully covered by credit", () => {
    const result = subscriptionRevenueCents(
      invoice({ lines: [{ type: "subscription", amount: 14_900 }], amountPaid: 0 })
    );
    expect(result).toBe(0);
  });

  it("never returns a negative amount", () => {
    const result = subscriptionRevenueCents(
      invoice({ lines: [{ type: "subscription", amount: -14_900 }], amountPaid: 0 })
    );
    expect(result).toBe(0);
  });
});

describe("plan ↔ Stripe price mapping", () => {
  beforeEach(() => {
    delete process.env.STRIPE_PRICE_PROFIT_INTELLIGENCE_MONTHLY;
    delete process.env.STRIPE_PRICE_PROFIT_INTELLIGENCE_PRO_MONTHLY;
    delete process.env.STRIPE_SECRET_KEY;
  });

  it("reads price IDs from the environment, never from source", () => {
    process.env.STRIPE_PRICE_PROFIT_INTELLIGENCE_MONTHLY = "price_live_149";
    process.env.STRIPE_PRICE_PROFIT_INTELLIGENCE_PRO_MONTHLY = "price_live_299";

    expect(priceIdForPlan("profit_intelligence")).toBe("price_live_149");
    expect(priceIdForPlan("profit_intelligence_pro")).toBe("price_live_299");
  });

  it("maps a known price back to its plan", () => {
    process.env.STRIPE_PRICE_PROFIT_INTELLIGENCE_MONTHLY = "price_149";
    process.env.STRIPE_PRICE_PROFIT_INTELLIGENCE_PRO_MONTHLY = "price_299";

    expect(planForPriceId("price_149")).toBe("profit_intelligence");
    expect(planForPriceId("price_299")).toBe("profit_intelligence_pro");
  });

  /**
   * A price created by hand in the Stripe dashboard must never silently
   * grant a plan - the webhook leaves the plan untouched when this is null.
   */
  it("returns null for an unrecognized price rather than guessing", () => {
    process.env.STRIPE_PRICE_PROFIT_INTELLIGENCE_MONTHLY = "price_149";
    expect(planForPriceId("price_created_by_hand")).toBeNull();
    expect(planForPriceId(null)).toBeNull();
    expect(planForPriceId(undefined)).toBeNull();
  });

  it("reports billing as unconfigured until every piece is present", () => {
    expect(isStripeConfigured()).toBe(false);

    process.env.STRIPE_SECRET_KEY = "sk_test_x";
    expect(isStripeConfigured()).toBe(false); // prices still missing

    process.env.STRIPE_PRICE_PROFIT_INTELLIGENCE_MONTHLY = "price_149";
    expect(isStripeConfigured()).toBe(false); // pro price still missing

    process.env.STRIPE_PRICE_PROFIT_INTELLIGENCE_PRO_MONTHLY = "price_299";
    expect(isStripeConfigured()).toBe(true);
  });

  it("treats a blank env var as unset", () => {
    process.env.STRIPE_PRICE_PROFIT_INTELLIGENCE_MONTHLY = "   ";
    expect(priceIdForPlan("profit_intelligence")).toBeNull();
  });
});
