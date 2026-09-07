import { prisma } from "./prisma";
import {
  PLANS,
  TRIAL_LIMITS,
  isPlanId,
  limitsForStoredPlan,
  planDisplayName,
  type PlanId,
  type PlanLimits,
  type StoredPlan,
} from "./plans";

// Single source of truth for what a given account may actually do right now.
//
// Two separate questions are answered here, and keeping them separate is the
// whole point of this module:
//
//   1. WHICH plan's features would this account get?   -> `plan`
//   2. Is that entitlement currently live?             -> `access` / `active`
//
// A trialing account has no paid plan yet but full access. A canceled
// account has a plan on record but no access. Conflating the two is how
// billing bugs turn into security bugs, so every gate in the app goes
// through getEntitlements()/requireFeature() rather than reading
// Subscription.plan directly.
//
// SECURITY: this module is server-only. Hiding a button in the browser is
// not an entitlement check - every gated API route and server component must
// call requireFeature() (or requireActiveEntitlement()) itself.

export type Plan = StoredPlan;

export type Feature =
  | "dashboard"
  | "jobs_table"
  | "job_detail"
  | "charts"
  | "data_health"
  | "weekly_email"
  | "on_demand_analysis"
  | "margin_alerts"
  | "ai_insights" // Profit Intelligence findings + recommended actions
  | "profit_opportunities" // cross-job pattern rollups
  | "forecast_at_completion"
  | "cross_job_benchmarking";

/**
 * The retired pre-launch tier. Kept only so existing rows resolve to
 * something sensible; it is not sold and never appears on the pricing page.
 */
const PROFIT_MONITOR_FEATURES: Feature[] = [
  "dashboard",
  "jobs_table",
  "job_detail",
  "charts",
  "data_health",
  "weekly_email",
  "on_demand_analysis",
  "margin_alerts",
];

/**
 * $149 Profit Intelligence. Deliberately includes ai_insights: the core
 * product promise ("tell me where I'm making money, where I'm losing it,
 * why, and what to do about it") has to be delivered by the entry paid plan,
 * not withheld to force an upgrade.
 */
const PROFIT_INTELLIGENCE_FEATURES: Feature[] = [...PROFIT_MONITOR_FEATURES, "ai_insights"];

/**
 * $299 Pro adds forward-looking and cross-job analysis - both of which are
 * real, shipped calculations (computeForecastAtCompletion and
 * computeProfitOpportunities in src/lib/profitability.ts), not placeholders.
 */
const PROFIT_INTELLIGENCE_PRO_FEATURES: Feature[] = [
  ...PROFIT_INTELLIGENCE_FEATURES,
  "profit_opportunities",
  "forecast_at_completion",
  "cross_job_benchmarking",
];

export const PLAN_FEATURES: Record<Plan, Feature[]> = {
  profit_monitor: PROFIT_MONITOR_FEATURES,
  profit_intelligence: PROFIT_INTELLIGENCE_FEATURES,
  profit_intelligence_pro: PROFIT_INTELLIGENCE_PRO_FEATURES,
};

/** A trial is full access, so a contractor evaluates the real product. */
const TRIAL_FEATURES: Feature[] = PROFIT_INTELLIGENCE_PRO_FEATURES;

export type AccessState =
  | "trialing"
  | "trial_expired"
  | "active"
  | "past_due"
  | "canceled"
  | "none";

export interface Entitlements {
  /** The plan whose features apply (or would apply, for a trial). */
  plan: Plan;
  planName: string;
  /** Resolved access state - what the UI should actually react to. */
  access: AccessState;
  /** True when paid/trial features are currently unlocked. */
  active: boolean;
  /** True specifically while inside a live free trial. */
  trialing: boolean;
  trialEndsAt: Date | null;
  /** Whole days left in the trial (0 once expired). */
  trialDaysRemaining: number;
  /** True when there's a payment problem but access is being retained. */
  paymentIssue: boolean;
  cancelAtPeriodEnd: boolean;
  currentPeriodEnd: Date | null;
  limits: PlanLimits;
  features: Set<Feature>;
  has: (feature: Feature) => boolean;
}

function daysUntil(from: Date, to: Date): number {
  return Math.max(0, Math.ceil((to.getTime() - from.getTime()) / 86_400_000));
}

/**
 * Resolves an account's live entitlement. Never throws for a missing
 * subscription row - an account without one simply has no access, which the
 * UI renders as the "choose a plan" experience rather than an error page.
 */
export async function getEntitlements(
  userId: string,
  now: Date = new Date()
): Promise<Entitlements> {
  const subscription = await prisma.subscription.findUnique({ where: { userId } });

  const storedPlan: Plan =
    subscription && (isPlanId(subscription.plan) || subscription.plan === "profit_monitor")
      ? (subscription.plan as Plan)
      : "profit_intelligence";

  if (!subscription) {
    return buildEntitlements({
      plan: storedPlan,
      access: "none",
      features: [],
      limits: limitsForStoredPlan(storedPlan),
      trialEndsAt: null,
      now,
      paymentIssue: false,
      cancelAtPeriodEnd: false,
      currentPeriodEnd: null,
    });
  }

  const trialEndsAt = subscription.trialEndsAt ?? null;
  const trialLive =
    subscription.status === "trialing" &&
    trialEndsAt != null &&
    trialEndsAt.getTime() > now.getTime();

  // A live trial takes precedence: full access regardless of what `plan` says.
  if (trialLive) {
    return buildEntitlements({
      plan: storedPlan,
      access: "trialing",
      features: TRIAL_FEATURES,
      limits: TRIAL_LIMITS,
      trialEndsAt,
      now,
      paymentIssue: false,
      cancelAtPeriodEnd: false,
      currentPeriodEnd: null,
    });
  }

  switch (subscription.status) {
    case "active":
      return buildEntitlements({
        plan: storedPlan,
        access: "active",
        features: PLAN_FEATURES[storedPlan],
        limits: limitsForStoredPlan(storedPlan),
        trialEndsAt,
        now,
        paymentIssue: false,
        cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
        currentPeriodEnd: subscription.currentPeriodEnd,
      });

    // Stripe retries a failed payment for roughly two weeks before giving up.
    // Cutting a paying contractor off the moment a card expires - while
    // Stripe is still retrying, and before they've necessarily seen the
    // email - is hostile and costs more in churn than it saves. Access is
    // retained and the billing UI shows a prominent warning instead. If
    // Stripe ultimately gives up, the status becomes canceled/unpaid and
    // access ends there.
    case "past_due":
      return buildEntitlements({
        plan: storedPlan,
        access: "past_due",
        features: PLAN_FEATURES[storedPlan],
        limits: limitsForStoredPlan(storedPlan),
        trialEndsAt,
        now,
        paymentIssue: true,
        cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
        currentPeriodEnd: subscription.currentPeriodEnd,
      });

    case "trialing": // status still says trialing, but trialEndsAt has passed
    case "trial_expired":
      return buildEntitlements({
        plan: storedPlan,
        access: "trial_expired",
        features: [],
        limits: limitsForStoredPlan(storedPlan),
        trialEndsAt,
        now,
        paymentIssue: false,
        cancelAtPeriodEnd: false,
        currentPeriodEnd: null,
      });

    default:
      // "canceled" | "unpaid" | "incomplete" | anything Stripe adds later.
      // Unknown statuses deny rather than grant: failing closed is the only
      // safe default for a billing gate.
      return buildEntitlements({
        plan: storedPlan,
        access: "canceled",
        features: [],
        limits: limitsForStoredPlan(storedPlan),
        trialEndsAt,
        now,
        paymentIssue: subscription.status === "unpaid",
        cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
        currentPeriodEnd: subscription.currentPeriodEnd,
      });
  }
}

function buildEntitlements(input: {
  plan: Plan;
  access: AccessState;
  features: Feature[];
  limits: PlanLimits;
  trialEndsAt: Date | null;
  now: Date;
  paymentIssue: boolean;
  cancelAtPeriodEnd: boolean;
  currentPeriodEnd: Date | null;
}): Entitlements {
  const features = new Set(input.features);
  const trialing = input.access === "trialing";
  return {
    plan: input.plan,
    planName: planDisplayName(input.plan),
    access: input.access,
    active:
      input.access === "trialing" || input.access === "active" || input.access === "past_due",
    trialing,
    trialEndsAt: input.trialEndsAt,
    trialDaysRemaining: trialing && input.trialEndsAt ? daysUntil(input.now, input.trialEndsAt) : 0,
    paymentIssue: input.paymentIssue,
    cancelAtPeriodEnd: input.cancelAtPeriodEnd,
    currentPeriodEnd: input.currentPeriodEnd,
    limits: input.limits,
    features,
    has: (feature: Feature) => features.has(feature),
  };
}

/**
 * Guard for gated pages and API routes. Returns the entitlements object when
 * the feature is unlocked, or null when it isn't - the caller decides
 * whether that means an upgrade screen (pages) or a 403 (API routes), since
 * those need different responses.
 */
export async function requireFeature(
  userId: string,
  feature: Feature
): Promise<Entitlements | null> {
  const entitlements = await getEntitlements(userId);
  return entitlements.has(feature) ? entitlements : null;
}

/** True when the account currently has any paid or trial access at all. */
export async function requireActiveEntitlement(userId: string): Promise<Entitlements | null> {
  const entitlements = await getEntitlements(userId);
  return entitlements.active ? entitlements : null;
}

// --- Plan limits ---------------------------------------------------------

export interface UsageAgainstLimits {
  connections: number;
  maxConnections: number;
  activeJobs: number;
  maxActiveJobs: number | null;
  overConnectionLimit: boolean;
  overJobLimit: boolean;
}

/**
 * Current usage measured against the account's plan limits.
 *
 * Note what this deliberately does NOT do: it never deletes, hides or
 * silently excludes a customer's jobs. If an account is over its job limit
 * (most often after a downgrade), everything they already have stays intact
 * and fully visible - the billing UI explains the overage and offers the
 * upgrade. Quietly truncating financial data to enforce a pricing tier would
 * be indefensible in a product people make money decisions with.
 */
export async function getUsageAgainstLimits(
  userId: string,
  entitlements?: Entitlements
): Promise<UsageAgainstLimits> {
  const ent = entitlements ?? (await getEntitlements(userId));

  const [connections, activeJobs] = await Promise.all([
    prisma.quickBooksConnection.count({ where: { userId, disconnectedAt: null } }),
    prisma.job.count({
      where: { status: "open", connection: { userId, disconnectedAt: null } },
    }),
  ]);

  const maxActiveJobs = ent.limits.maxActiveJobs;

  return {
    connections,
    maxConnections: ent.limits.maxConnections,
    activeJobs,
    maxActiveJobs,
    overConnectionLimit: connections > ent.limits.maxConnections,
    overJobLimit: maxActiveJobs != null && activeJobs > maxActiveJobs,
  };
}

/**
 * Hard gate used before starting a new QuickBooks OAuth flow. Unlike the job
 * limit (which is reported, never enforced destructively), connecting an
 * ADDITIONAL company is a discrete user action we can cleanly refuse up front
 * with a clear explanation.
 */
export async function canConnectAnotherCompany(
  userId: string
): Promise<{ allowed: boolean; reason?: string; usage: UsageAgainstLimits }> {
  const entitlements = await getEntitlements(userId);
  const usage = await getUsageAgainstLimits(userId, entitlements);

  if (!entitlements.active) {
    return {
      allowed: false,
      reason: "Your trial has ended. Choose a plan to connect a QuickBooks company.",
      usage,
    };
  }

  if (usage.connections >= usage.maxConnections) {
    const planLabel = entitlements.trialing ? "Your free trial" : entitlements.planName;
    const upgradeHint =
      entitlements.plan === "profit_intelligence_pro"
        ? "Email support@jobprofitai.com if you need to connect more than 3 companies."
        : `Profit Intelligence Pro covers up to ${PLANS.profit_intelligence_pro.limits.maxConnections} companies.`;
    return {
      allowed: false,
      reason: `${planLabel} covers ${usage.maxConnections} QuickBooks ${
        usage.maxConnections === 1 ? "company" : "companies"
      } and you've already connected ${usage.connections}. ${upgradeHint}`,
      usage,
    };
  }

  return { allowed: true, usage };
}

// --- Admin ---------------------------------------------------------------

/**
 * Admin access comes from an explicit allowlist of email addresses in the
 * ADMIN_EMAILS env var (comma-separated), rather than a database flag that a
 * bug in an ordinary write path could flip. Unset means nobody is an admin,
 * which is the correct default for a fresh environment.
 */
export function isAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const allowed = (process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  if (allowed.length === 0) return false;
  return allowed.includes(email.trim().toLowerCase());
}

/** Resolves the session user and checks the admin allowlist. */
export async function isAdminUser(userId: string): Promise<boolean> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
  return isAdminEmail(user?.email);
}

export { PLANS };
export type { PlanId, PlanLimits };
