import Stripe from "stripe";
import { PLANS, PLAN_IDS, type PlanId } from "@/lib/plans";

// Stripe client + the mapping between JobProfitAI plans and Stripe Prices.
//
// Price IDs are never hardcoded. They come from environment variables, which
// is what keeps test-mode and live-mode cleanly separated: the same code
// path runs in both, and which Stripe account/mode it talks to is purely a
// function of which STRIPE_SECRET_KEY + price IDs are present in that
// environment. A live key paired with a test price (or vice versa) fails
// loudly at checkout rather than silently doing the wrong thing.

/**
 * Pinned to the API version this SDK (stripe-node 16.x) was generated
 * against. Pinning matters for webhooks specifically: an account whose
 * default API version drifts would start delivering event payloads shaped
 * differently than the types we compile against.
 */
const STRIPE_API_VERSION = "2024-06-20" as const;

let cachedStripe: Stripe | null = null;

/**
 * Returns the Stripe client, or throws a clear error if billing isn't
 * configured. Callers in request paths should catch this and surface
 * "billing isn't set up yet" rather than a 500 - see
 * src/app/api/billing/checkout/route.ts.
 */
export function getStripe(): Stripe {
  if (cachedStripe) return cachedStripe;

  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) {
    throw new Error("STRIPE_SECRET_KEY is not set - Stripe billing is not configured.");
  }

  cachedStripe = new Stripe(secretKey, {
    apiVersion: STRIPE_API_VERSION,
    appInfo: { name: "JobProfitAI", url: "https://jobprofitai.com" },
    // Stripe's own transient-failure retry. Safe because every write we make
    // is either idempotent by construction or guarded by a database unique
    // constraint (see StripeEvent / ReferralReward / PartnerCommission).
    maxNetworkRetries: 2,
  });
  return cachedStripe;
}

/** True when the environment has enough configuration to run a checkout. */
export function isStripeConfigured(): boolean {
  return Boolean(process.env.STRIPE_SECRET_KEY) && PLAN_IDS.every((id) => Boolean(priceIdForPlan(id)));
}

/** The configured Stripe Price ID for a plan, or null when it isn't set. */
export function priceIdForPlan(plan: PlanId): string | null {
  const value = process.env[PLANS[plan].stripePriceEnvVar];
  return value && value.trim() ? value.trim() : null;
}

/** Same as priceIdForPlan but throws with an actionable message. */
export function requirePriceIdForPlan(plan: PlanId): string {
  const priceId = priceIdForPlan(plan);
  if (!priceId) {
    throw new Error(
      `${PLANS[plan].stripePriceEnvVar} is not set - cannot start checkout for ${PLANS[plan].name}.`
    );
  }
  return priceId;
}

/**
 * Reverse lookup: which plan does this Stripe Price belong to?
 *
 * Used by the webhook handler to decide what a subscription actually
 * entitles someone to. Returns null for an unrecognized price - the handler
 * treats that as "don't change the plan" rather than guessing, so a price
 * created by hand in the Stripe dashboard can never silently grant Pro.
 */
export function planForPriceId(priceId: string | null | undefined): PlanId | null {
  if (!priceId) return null;
  for (const id of PLAN_IDS) {
    if (priceIdForPlan(id) === priceId) return id;
  }
  return null;
}

/** Absolute app URL for Stripe redirect targets. */
export function appUrl(path = ""): string {
  const base = (process.env.APP_URL ?? "").replace(/\/+$/, "");
  if (!base) {
    throw new Error("APP_URL is not set - cannot build Stripe redirect URLs.");
  }
  return path ? `${base}${path.startsWith("/") ? path : `/${path}`}` : base;
}

export { STRIPE_API_VERSION };
export type { Stripe };
