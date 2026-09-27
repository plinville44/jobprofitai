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
 * Contractors choose between exactly two paid plans. There is no Starter
 * tier, no freemium tier, and no sub-$149 plan - that's a strategic
 * decision, not an oversight: the trial is what removes purchase friction,
 * not a cheap tier. Bookkeeping and accounting firms have a third plan,
 * Firm, priced per client company with a four-company minimum ($316 a
 * month at least), so it's never cheaper than Pro ($299) for one contractor.
 * (A three-company minimum was considered and rejected: at $237 it undercut
 * Pro while including everything in it.)
 */

export type PlanId = "profit_intelligence" | "profit_intelligence_pro" | "firm";

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
  /** What the price is per, after priceLabel: "/month", or " per company/month" for Firm. */
  priceSuffix: string;
  /** Firm: billed per connected QuickBooks company, with this minimum. */
  perCompany?: { minCompanies: number };
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
    priceSuffix: "/month",
    tagline: "See what to change to make more money on your jobs, and what each change is worth.",
    bestFor:
      "Contractors who want to know where their pricing leaks money and what to fix first.",
    mostPopular: true,
    limits: { maxConnections: 1, maxActiveJobs: 100, maxTeamMembers: 3 },
    marketingFeatures: [
      // Connection + scale
      "1 QuickBooks Online company",
      "Up to 100 active jobs",
      // jobSource: projects | customers | classes (src/lib/qboNormalize.ts selectJobClasses)
      "Jobs from QuickBooks Projects, customers or Classes",
      // src/lib/team.ts
      "3 team logins for your office manager, PMs or bookkeeper",
      // The Profit Opportunity Feed - src/lib/opportunities.ts computeOpportunityFeed
      "Profit Opportunity Feed: what to change, ranked by what it's worth",
      "Pricing gaps by job type, customer, job size and part of the job (labor, materials, subs)",
      // computeEstimateCheck + costFromQuantities + /dashboard/estimates
      "Estimate Check: pending QuickBooks estimates checked against your own finished jobs",
      "Estimates costed from their quantities: hours at your real labor cost, items at their QuickBooks cost",
      // ProfitAction + computeActionOutcome
      "Track a pricing change and see its result on the jobs that follow",
      // JobType + src/lib/jobTypeSuggestions.ts
      "Your own job types, with suggestions from job names, estimates and AI",
      // Core profitability - src/lib/profitability.ts computeJobFinancials/computeDashboardTotals
      "Job profitability dashboard",
      "Revenue, cost, gross profit and margin by job",
      // TimeActivity CostRate - src/lib/qboNormalize.ts timeActivityCost; burdenedAmount
      "Labor at each person's pay rate from QuickBooks timesheets, plus your labor burden",
      "Cost breakdown by category (labor, materials, subs, equipment)",
      "Estimate vs. actual comparison",
      // src/lib/qboCheck.ts + /api/jobs/[jobId]/quickbooks-check
      "Check any job against QuickBooks' own numbers in one click",
      // computeWip + buildWipSchedule + /dashboard/wip + /reports/wip + /api/wip/export
      "WIP report: over and under billing by job, with CSV export",
      "Bank-ready WIP schedule for your bank or bonding company, to print or save as PDF",
      // computeMoneyOwed + /dashboard/money-owed
      "Money you're owed: work done but not billed, possible change orders and unpaid invoices",
      // Margin leak detection - computeNeedsAttentionForJob + computeProfitLeakage;
      // emails from src/lib/alerts.ts via the nightly sync
      "Margin leak detection, with email alerts when a job goes over its estimate or gets ahead of its billing",
      "Jobs-below-target-margin tracking",
      "Profit leakage breakdown per job",
      // Trends - getMarginTrend, computeMarginTrend
      "Historical profitability trends",
      "Margin by job type, month by month",
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
    priceSuffix: "/month",
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
  firm: {
    id: "firm",
    name: "Firm",
    // Per company. The Stripe price is $79 a unit; the subscription's
    // quantity is the number of connected companies, never below four.
    priceCents: 7_900,
    priceLabel: "$79",
    priceSuffix: " per company/month",
    perCompany: { minCompanies: 4 },
    tagline: "Every client's job profit in one login, priced per company.",
    bestFor: "Bookkeepers and accountants who keep the books for contractors.",
    mostPopular: false,
    limits: { maxConnections: 100, maxActiveJobs: null, maxTeamMembers: 10 },
    marketingFeatures: [
      "$79 per client company a month, 4 minimum, billed on the companies you connect",
      "Everything in Profit Intelligence Pro, for every client",
      // /dashboard/portfolio
      "Portfolio view: every client's margin, open jobs, unpaid invoices and data gaps on one page",
      // TeamMember role "client" (src/lib/team.ts, src/lib/account.ts)
      "View-only logins for your clients, each seeing only their own company",
      "10 staff logins for your team",
      "Priority support",
    ],
    stripePriceEnvVar: "STRIPE_PRICE_FIRM_MONTHLY",
  },
};

/** Every plan that can be bought. */
export const PLAN_IDS: PlanId[] = ["profit_intelligence", "profit_intelligence_pro", "firm"];

/** The two plans a contractor chooses between. */
export const CONTRACTOR_PLAN_IDS: PlanId[] = ["profit_intelligence", "profit_intelligence_pro"];

/** The contractor plans, ordered for display (cheapest first). Firm is shown on its own. */
export const PLAN_LIST: PlanDefinition[] = CONTRACTOR_PLAN_IDS.map((id) => PLANS[id]);

/** View-only client logins a Firm account can give each client company. */
export const CLIENT_LOGINS_PER_COMPANY = 3;

/** Companies a Firm subscription is billed for: the connected ones, never below the minimum. */
export function firmBillableCompanies(connectedCompanies: number): number {
  return Math.max(PLANS.firm.perCompany!.minCompanies, Math.max(0, Math.floor(connectedCompanies)));
}

/**
 * One month of a plan in cents: the plan's price, or for Firm the monthly
 * bill for the companies it's billed for (the minimum when not known).
 */
export function monthlyPriceCents(plan: string, quantity?: number | null): number {
  if (plan === "firm") return PLANS.firm.priceCents * firmBillableCompanies(quantity ?? 0);
  return priceCentsForStoredPlan(plan);
}

/** "$149/month", or "$79 per company/month" for Firm. */
export function planPriceText(plan: PlanId): string {
  return `${PLANS[plan].priceLabel}${PLANS[plan].priceSuffix}`;
}

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
  // Firm is per company: its smallest monthly bill.
  if (plan === "firm") return PLANS.firm.priceCents * firmBillableCompanies(0);
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
