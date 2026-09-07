import { describe, it, expect } from "vitest";
import {
  PLANS,
  PLAN_IDS,
  PLAN_LIST,
  PARTNER_COMMISSION_MONTHS,
  PARTNER_TIERS,
  REFERRAL_QUALIFY_DAYS,
  TRIAL_DAYS,
  TRIAL_EXTENSION_DAYS,
  isPlanId,
  limitsForStoredPlan,
  nextPartnerTier,
  partnerTierFor,
  priceCentsForStoredPlan,
} from "../plans";

describe("plan catalog", () => {
  it("sells exactly two plans, at $149 and $299", () => {
    expect(PLAN_IDS).toEqual(["profit_intelligence", "profit_intelligence_pro"]);
    expect(PLANS.profit_intelligence.priceCents).toBe(14_900);
    expect(PLANS.profit_intelligence_pro.priceCents).toBe(29_900);
    expect(PLANS.profit_intelligence.priceLabel).toBe("$149");
    expect(PLANS.profit_intelligence_pro.priceLabel).toBe("$299");
  });

  /**
   * Guards the explicit product decision that there is no cheap anchor tier.
   * If someone later adds a Starter/$49/$79 plan, this fails loudly rather
   * than the pricing page quietly gaining a tier nobody signed off on.
   */
  it("has no plan below $149 and no starter/freemium tier", () => {
    for (const plan of PLAN_LIST) {
      expect(plan.priceCents).toBeGreaterThanOrEqual(14_900);
      expect(plan.id).not.toMatch(/starter|basic|free|lite/i);
      expect(plan.name).not.toMatch(/starter|basic|free|lite/i);
    }
    expect(PLAN_LIST).toHaveLength(2);
  });

  it("marks only one plan as most popular", () => {
    expect(PLAN_LIST.filter((p) => p.mostPopular)).toHaveLength(1);
    expect(PLANS.profit_intelligence.mostPopular).toBe(true);
  });

  it("uses distinct, non-hardcoded Stripe price env vars", () => {
    expect(PLANS.profit_intelligence.stripePriceEnvVar).toBe(
      "STRIPE_PRICE_PROFIT_INTELLIGENCE_MONTHLY"
    );
    expect(PLANS.profit_intelligence_pro.stripePriceEnvVar).toBe(
      "STRIPE_PRICE_PROFIT_INTELLIGENCE_PRO_MONTHLY"
    );
    expect(PLANS.profit_intelligence.stripePriceEnvVar).not.toBe(
      PLANS.profit_intelligence_pro.stripePriceEnvVar
    );
  });

  it("applies the advertised plan limits", () => {
    expect(PLANS.profit_intelligence.limits).toEqual({ maxConnections: 1, maxActiveJobs: 100 });
    expect(PLANS.profit_intelligence_pro.limits).toEqual({
      maxConnections: 3,
      maxActiveJobs: null,
    });
  });

  it("falls back conservatively for unknown or retired plan values", () => {
    expect(isPlanId("profit_monitor")).toBe(false);
    expect(limitsForStoredPlan("profit_monitor")).toEqual({
      maxConnections: 1,
      maxActiveJobs: 100,
    });
    expect(limitsForStoredPlan("something_invented")).toEqual({
      maxConnections: 1,
      maxActiveJobs: 100,
    });
  });

  it("prices referral rewards from the referrer's stored plan", () => {
    expect(priceCentsForStoredPlan("profit_intelligence")).toBe(14_900);
    expect(priceCentsForStoredPlan("profit_intelligence_pro")).toBe(29_900);
    // A legacy tier still earns a defensible credit rather than $0.
    expect(priceCentsForStoredPlan("profit_monitor")).toBe(14_900);
  });

  it("uses the documented trial and referral windows", () => {
    expect(TRIAL_DAYS).toBe(14);
    expect(TRIAL_EXTENSION_DAYS).toBe(14);
    expect(REFERRAL_QUALIFY_DAYS).toBe(30);
    expect(PARTNER_COMMISSION_MONTHS).toBe(12);
  });
});

describe("partner commission tiers", () => {
  it("resolves 20% / 25% / 30% at the documented thresholds", () => {
    expect(partnerTierFor(1).ratePct).toBe(20);
    expect(partnerTierFor(9).ratePct).toBe(20);
    expect(partnerTierFor(10).ratePct).toBe(25);
    expect(partnerTierFor(24).ratePct).toBe(25);
    expect(partnerTierFor(25).ratePct).toBe(30);
    expect(partnerTierFor(500).ratePct).toBe(30);
  });

  it("puts a firm with roughly 20 paying clients in the 25% tier", () => {
    // Called out explicitly in the program spec as the worked example.
    expect(partnerTierFor(20).ratePct).toBe(25);
    expect(partnerTierFor(20).rateBps).toBe(2500);
  });

  it("still pays the entry rate on a partner's very first conversion", () => {
    expect(partnerTierFor(0).ratePct).toBe(20);
  });

  it("reports progress to the next tier, and none at the top", () => {
    expect(nextPartnerTier(3)?.minPayingClients).toBe(10);
    expect(nextPartnerTier(12)?.minPayingClients).toBe(25);
    expect(nextPartnerTier(25)).toBeNull();
    expect(nextPartnerTier(99)).toBeNull();
  });

  it("expresses rates in basis points that divide cleanly", () => {
    for (const tier of PARTNER_TIERS) {
      expect(tier.rateBps).toBe(tier.ratePct * 100);
    }
  });

  /** The economics quoted to partners on the marketing site. */
  it("produces the advertised per-client commission amounts", () => {
    const at = (priceCents: number, bps: number) => Math.round((priceCents * bps) / 10_000);
    expect(at(14_900, 2500)).toBe(3_725); // $37.25 on a $149 client at 25%
    expect(at(29_900, 2500)).toBe(7_475); // $74.75 on a $299 client at 25%
    expect(at(14_900, 2000)).toBe(2_980); // $29.80 at 20%
    expect(at(29_900, 3000)).toBe(8_970); // $89.70 at 30%
  });
});
