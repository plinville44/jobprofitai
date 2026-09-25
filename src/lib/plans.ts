/**
 * The plan catalog: the single source of truth for what JobProfitAI sells,
 * what each plan costs, what it unlocks, and what its limits are.
 *
 * Both the marketing site and the application read from this file, on
 * purpose. The failure mode this prevents is the pricing page advertising
 * something the entitlement layer doesn't actually grant (or vice versa) -
 * if a feature is listed in `marketingFeatures` below, it is because the
 * corresponding `Feature` flag is in that plan's set in entitlements.ts and
 * there is real code behind it.
 *
 * Deliberately dependency-free (no Prisma, no Stripe SDK) so it can be
 * imported from client components, server components, and the marketing
 * pages alike.
 *
 * Launch pricing is exactly two paid plans. There is no Starter tier, no
 * freemium tier, and no sub-$149 plan - that's a strategic decision, not an
 * oversight: the trial is what removes purchase friction, not a cheap tier.
 */

export type PlanId = "profit_intelligence" | "profit_intelligence_pro";

/** Includes the pre-launch tier that is no longer sold but may exist on old rows. */
export type StoredPlan = PlanId | "profit_monitor";

export interface PlanLimits {
  /** Connected QuickBooks Online companies. */
  maxConnections: number;
  /** Active (open) jobs covered by the plan. `null` = unlimited. */
  maxActiveJobs: number | null;
  /** Team logins the owner can invite, not counting the owner. */
  maxTeamMembers: number;
}

export interface PlanDefinition {
  id: PlanId;
  name: string;
  /** Monthly price in cents - the authoritative number for referral rewards. */
  priceCents: number;
  /** Display price, e.g. "$149". */
  priceLabel: string;
  tagline: string;
  /** Shown on the pricing page under the price. */
  bestFor: string;
  mostPopular: boolean;
  limits: PlanLimits;
  /**
   * Exact bullets shown on the marketing site. Every line here maps to
   * shipped functionality - see the audit note against each group below.
   * Nothing aspirational goes in this array.
   */
  marketingFeatures: string[];
  /** Name of the env var holding this plan's Stripe Price ID. */
  stripePriceEnvVar: string;
}

export const PLANS: Record<PlanId, PlanDefinition> = {
  profit_intelligence: {
    id: "profit_intelligence",
    name: "Profit Intelligence",
    priceCents: 14_900,
    priceLabel: "$149",
    tagline: "See what to change to make more money on your jobs, and what each change is worth.",
    bestFor:
      "Contractors who want to know where their pricing leaks money and what to fix first.",
    mostPopular: true,
    limits: { maxConnections: 1, maxActiveJobs: 100, maxTeamMembers: 3 },
    marketingFeatures: [
      // Connection + scale
      "1 QuickBooks Online company",
      "Up to 100 active jobs",
      // src/lib/team.ts
      "3 team logins for your office manager, PMs or bookkeeper",
      // The Profit Opportunity Feed - src/lib/opportunities.ts computeOpportunityFeed
      "Profit Opportunity Feed: what to change, ranked by what it's worth",
      "Pricing gaps by job type, customer, job size and part of the job (labor, materials, subs)",
      // computeEstimateCheck + /dashboard/estimates
      "Estimate Check: pending QuickBooks estimates checked against your own finished jobs",
      // ProfitAction + computeActionOutcome
      "Track a pricing change and see its result on the jobs that follow",
      // JobType + src/lib/jobTypeSuggestions.ts
      "Your own job types, with suggestions from job names, estimates and AI",
      // Core profitability - src/lib/profitability.ts computeJobFinancials/computeDashboardTotals
      "Job profitability dashboard",
      "Revenue, cost, gross profit and margin by job",
      // TimeActivity CostRate - src/lib/qboNormalize.ts timeActivityCost
      "Labor at each person's pay rate from QuickBooks timesheets",
      "Cost breakdown by category (labor, materials, subs, equipment)",
      "Estimate vs. actual comparison",
      // src/lib/qboCheck.ts + /api/jobs/[jobId]/quickbooks-check
      "Check any job against QuickBooks' own numbers in one click",
      // computeWip + /dashboard/wip + /api/wip/export
      "WIP report: over and under billing by job, with CSV export",
      // Margin leak detection - computeNeedsAttentionForJob + computeProfitLeakage;
      // emails from src/lib/alerts.ts via the nightly sync
      "Margin leak detection, with email alerts when a job goes over its estimate or gets ahead of its billing",
      "Jobs-below-target-margin tracking",
      "Profit leakage breakdown per job",
      // Trends - getMarginTrend
      "Historical profitability trends",
      // Intelligence - src/lib/intelligence.ts (this is the core promise; it is
      // deliberately NOT held back for the higher tier)
      "AI advisor notes on your opportunities (the figures are calculated, never written by AI)",
      // Data health - computeDataHealth
      "Data Health checks on your QuickBooks data",
      // Weekly email - src/app/api/cron/weekly-email
      "Weekly Profit Brief by email, leading with new margin risk and estimates to fix",
      "Email support",
    ],
    stripePriceEnvVar: "STRIPE_PRICE_PROFIT_INTELLIGENCE_MONTHLY",
  },
  profit_intelligence_pro: {
    id: "profit_intelligence_pro",
    name: "Profit Intelligence Pro",
    priceCents: 29_900,
    priceLabel: "$299",
    tagline: "Everything in Profit Intelligence, plus forecasts for jobs in progress and more scale.",
    bestFor:
      "Larger or growing contractors who need more scale and forward-looking analysis.",
    mostPopular: false,
    limits: { maxConnections: 3, maxActiveJobs: null, maxTeamMembers: 10 },
    marketingFeatures: [
      "Everything in Profit Intelligence",
      "Up to 3 QuickBooks Online companies",
      "Unlimited active jobs",
      "10 team logins",
      // computeForecastAtCompletion - real, and gated to this tier today;
      // forecast_below_target alerts and feed items come with it
      "Forecast at completion on in-progress jobs, with an alert and an opportunity when one heads below target",
      // the peer cost-outlier rule in computeNeedsAttentionForJob
      "Benchmarking: each job's costs against your similar finished jobs",
      "Priority support",
    ],
    stripePriceEnvVar: "STRIPE_PRICE_PROFIT_INTELLIGENCE_PRO_MONTHLY",
  },
};

export const PLAN_IDS: PlanId[] = ["profit_intelligence", "profit_intelligence_pro"];

/** Ordered for display (cheapest first). */
export const PLAN_LIST: PlanDefinition[] = PLAN_IDS.map((id) => PLANS[id]);

export function isPlanId(value: unknown): value is PlanId {
  return typeof value === "string" && (PLAN_IDS as string[]).includes(value);
}

/**
 * Limits for any stored plan value, including the retired "profit_monitor"
 * tier and unrecognized values (which fall back to the most conservative
 * limits rather than accidentally granting unlimited access).
 */
export function limitsForStoredPlan(plan: string): PlanLimits {
  if (isPlanId(plan)) return PLANS[plan].limits;
  return { maxConnections: 1, maxActiveJobs: 100, maxTeamMembers: 3 };
}

/**
 * A trial is full access - the Pro feature set and Pro limits - so a
 * contractor evaluates the real product rather than a hobbled version.
 * That's the whole reason there's no cheap tier: the trial does the job a
 * Starter plan otherwise would.
 */
export const TRIAL_LIMITS: PlanLimits = PLANS.profit_intelligence_pro.limits;

/** Monthly price in cents for a stored plan value - used to size referral rewards. */
export function priceCentsForStoredPlan(plan: string): number {
  if (isPlanId(plan)) return PLANS[plan].priceCents;
  // Retired/unknown tiers reward at the entry plan price rather than $0, so a
  // legacy account that refers someone still gets a defensible credit.
  return PLANS.profit_intelligence.priceCents;
}

/**
 * How each subscription status is named to a person, on every screen. The
 * billing page and the admin trials tab used to have their own versions,
 * so the same account read "Payment overdue" in one and "past_due" in the
 * other, and a checkout that never completed showed as "Trial ended".
 */
export const SUBSCRIPTION_STATUS_LABELS: Record<string, string> = {
  trialing: "Free trial",
  trial_expired: "Trial ended",
  active: "Active",
  past_due: "Payment overdue",
  canceled: "Canceled",
  incomplete: "Checkout not completed",
  incomplete_expired: "Checkout not completed",
  unpaid: "Unpaid, access paused",
};

export function planDisplayName(plan: string): string {
  if (isPlanId(plan)) return PLANS[plan].name;
  if (plan === "profit_monitor") return "Profit Monitor (legacy)";
  return "Unknown plan";
}

// --- Trial configuration -------------------------------------------------

export const TRIAL_DAYS = 14;
export const TRIAL_EXTENSION_DAYS = 14;
/**
 * The extension offer opens this many days into the initial trial. Day 12 of
 * a 14-day trial, i.e. with 2 days left, per the growth plan.
 */
export const TRIAL_EXTENSION_OFFER_DAY = 12;

// --- Partner commission tiers -------------------------------------------

export interface PartnerTier {
  key: "tier_1" | "tier_2" | "tier_3";
  label: string;
  minPayingClients: number;
  /** Basis points: 2000 = 20%. */
  rateBps: number;
  ratePct: number;
}

/** Ordered highest-threshold-first so tier resolution is a simple `.find()`. */
export const PARTNER_TIERS: PartnerTier[] = [
  { key: "tier_3", label: "25+ paying clients", minPayingClients: 25, rateBps: 3000, ratePct: 30 },
  { key: "tier_2", label: "10-24 paying clients", minPayingClients: 10, rateBps: 2500, ratePct: 25 },
  { key: "tier_1", label: "1-9 paying clients", minPayingClients: 1, rateBps: 2000, ratePct: 20 },
];

/** Commission applies to the first 12 successfully paid subscription months per referred client. */
export const PARTNER_COMMISSION_MONTHS = 12;

/** Active paying clients at which a partner earns a complimentary firm account. */
export const PARTNER_FREE_ACCOUNT_THRESHOLD = 3;

/**
 * Resolve the commission rate for a partner with this many currently-paying
 * referred clients. Below the first threshold the rate is the entry tier -
 * a partner's first ever conversion earns 20%, it isn't unpaid.
 */
export function partnerTierFor(payingClients: number): PartnerTier {
  return (
    PARTNER_TIERS.find((t) => payingClients >= t.minPayingClients) ??
    PARTNER_TIERS[PARTNER_TIERS.length - 1]
  );
}

/** The next tier up, or null when already at the top. */
export function nextPartnerTier(payingClients: number): PartnerTier | null {
  const ascending = [...PARTNER_TIERS].reverse();
  return ascending.find((t) => t.minPayingClients > payingClients) ?? null;
}

// --- Referral program ----------------------------------------------------

/**
 * A referred customer must stay successfully paid this long before the
 * referrer's free month is earned. Guards against sign-up-and-refund abuse.
 */
export const REFERRAL_QUALIFY_DAYS = 30;
