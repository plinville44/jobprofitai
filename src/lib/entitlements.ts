import { prisma } from "./prisma";

// Single source of truth for what each subscription plan unlocks. Every
// feature gate in the app - pages, API routes, nav items - goes through
// getEntitlements()/requireFeature() below rather than checking
// Subscription.plan directly, so adding a plan or moving a feature between
// tiers later is a one-line change here instead of a hunt across the codebase.

export type Plan = "profit_monitor" | "profit_intelligence";

export type Feature =
  | "dashboard"
  | "jobs_table"
  | "job_detail"
  | "charts"
  | "data_health"
  | "weekly_email"
  | "on_demand_analysis"
  | "margin_alerts"
  | "exports"
  | "ai_insights" // Profit Intelligence recommendations
  | "profit_opportunities"
  | "forecast_at_completion"
  | "cross_job_benchmarking"
  | "advanced_risk_alerts";

const PROFIT_MONITOR_FEATURES: Feature[] = [
  "dashboard",
  "jobs_table",
  "job_detail",
  "charts",
  "data_health",
  "weekly_email",
  "on_demand_analysis",
  "margin_alerts",
  "exports",
];

const PROFIT_INTELLIGENCE_FEATURES: Feature[] = [
  ...PROFIT_MONITOR_FEATURES,
  "ai_insights",
  "profit_opportunities",
  "forecast_at_completion",
  "cross_job_benchmarking",
  "advanced_risk_alerts",
];

export const PLAN_FEATURES: Record<Plan, Feature[]> = {
  profit_monitor: PROFIT_MONITOR_FEATURES,
  profit_intelligence: PROFIT_INTELLIGENCE_FEATURES,
};

export interface Entitlements {
  plan: Plan;
  features: Set<Feature>;
  has: (feature: Feature) => boolean;
}

/**
 * Reads the user's plan and returns what it unlocks. Subscription.plan
 * defaults to "profit_intelligence" at the schema level right now (Preston's
 * explicit beta decision, 2026-08-14, since Stripe billing isn't wired up
 * yet) - this function doesn't hardcode a bypass, it just reads whatever the
 * Subscription row says, so changing the default the day billing goes live
 * is a schema default change plus backfilling existing rows, not a
 * rearchitecture.
 */
export async function getEntitlements(userId: string): Promise<Entitlements> {
  const subscription = await prisma.subscription.findUnique({ where: { userId } });
  const plan = (subscription?.plan as Plan) ?? "profit_intelligence";
  const features = new Set(PLAN_FEATURES[plan] ?? PROFIT_MONITOR_FEATURES);
  return { plan, features, has: (feature: Feature) => features.has(feature) };
}

/**
 * Guard for gated pages/API routes. Returns the entitlements object if the
 * feature is unlocked; returns null if not (caller decides whether to show
 * an upgrade message or a 403 JSON response - this function doesn't redirect
 * itself, since pages and API routes need different responses).
 */
export async function requireFeature(userId: string, feature: Feature): Promise<Entitlements | null> {
  const entitlements = await getEntitlements(userId);
  return entitlements.has(feature) ? entitlements : null;
}
