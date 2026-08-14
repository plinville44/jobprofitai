import { Prisma } from "@prisma/client";
import { prisma } from "./prisma";

// ============================================================================
// PURE CALCULATION LAYER
// ----------------------------------------------------------------------------
// Everything below the "PURE" marker takes plain data in and returns plain
// data out - no Prisma calls, no Date.now(), no randomness. This is
// deliberate: it's what the App spec calls "deterministic" (same input,
// same output, forever) and it's what makes these functions unit-testable
// with fixture data in Phase 8 (Vitest) without mocking a database.
//
// AI (src/lib/digest.ts, src/lib/intelligence.ts) is only ever handed the
// *output* of these functions as finished JSON. It never sees raw
// transactions and never computes a dollar figure, margin %, confidence
// level, or forecast number itself.
//
// Everything below the "ASYNC WRAPPERS" marker does the Prisma fetch and
// calls into the pure layer above - this is what pages/routes actually call.
// ============================================================================

export type DataConfidence = "insufficient_data" | "low" | "medium" | "high";

export interface CostEntryInput {
  category: string;
  amount: number;
  txnDate: Date;
}

export interface InvoiceInput {
  amount: number;
  status: string;
  txnDate: Date;
}

export interface JobInput {
  id: string;
  name: string;
  customerName: string | null;
  status: string; // "open" | "closed"
  category: string | null;
  estimatedRevenue: number | null;
  estimatedCost: number | null;
  startDate: Date | null;
  endDate: Date | null;
  updatedAt: Date;
  costEntries: CostEntryInput[];
  invoices: InvoiceInput[];
}

export interface FinancialContext {
  now: Date; // passed in, never Date.now() inline, so results are reproducible in tests
  targetMarginPct: number | null; // connection default
  categoryTargetMarginPct: Record<string, number>; // category -> override
  overheadEnabled: boolean;
  overheadMethod: "pct_of_revenue" | "pct_of_direct_cost" | null;
  overheadValue: number | null; // stored as a fraction, e.g. 0.12 for 12%
  lastSyncedAt: Date | null;
}

export interface JobFinancials {
  jobId: string;
  jobName: string;
  customerName: string | null;
  status: string;
  category: string | null;

  revenue: number;
  estimatedRevenue: number | null;
  costs: number;
  estimatedCost: number | null;
  costByCategory: Record<string, number>;

  profitabilityAvailable: boolean;
  unavailableReason: string | null;

  grossProfit: number | null;
  grossMarginPct: number | null;

  fullyLoadedProfit: number | null; // only non-null when overhead is enabled+configured AND profitability is available
  fullyLoadedMarginPct: number | null;

  targetMarginPct: number | null;
  varianceVsEstimate: number | null; // costs - estimatedCost, positive = over budget
  varianceVsEstimatePct: number | null;

  dataConfidence: DataConfidence;
  confidenceReasons: string[]; // human-readable "why" for the confidence level, per the no-false-precision requirement

  lastFinancialActivity: Date | null;

  flags: string[]; // machine-readable flags, consumed by computeNeedsAttentionForJob and legacy digest code
}

/**
 * Computes one job's financial picture. Pure and deterministic: identical
 * JobInput + FinancialContext always produces identical output.
 */
export function computeJobFinancials(job: JobInput, ctx: FinancialContext): JobFinancials {
  const revenue = job.invoices.reduce((s, i) => s + i.amount, 0);
  const costs = job.costEntries.reduce((s, c) => s + c.amount, 0);

  const costByCategory: Record<string, number> = {};
  for (const c of job.costEntries) {
    costByCategory[c.category] = (costByCategory[c.category] ?? 0) + c.amount;
  }

  const lastCostDate = job.costEntries.reduce<Date | null>(
    (latest, c) => (!latest || c.txnDate > latest ? c.txnDate : latest),
    null
  );
  const lastInvoiceDate = job.invoices.reduce<Date | null>(
    (latest, i) => (!latest || i.txnDate > latest ? i.txnDate : latest),
    null
  );
  const lastFinancialActivity =
    lastCostDate && lastInvoiceDate
      ? lastCostDate > lastInvoiceDate
        ? lastCostDate
        : lastInvoiceDate
      : lastCostDate ?? lastInvoiceDate;

  const flags: string[] = [];
  const targetMarginPct = job.category && ctx.categoryTargetMarginPct[job.category] != null
    ? ctx.categoryTargetMarginPct[job.category]
    : ctx.targetMarginPct;

  // --- Core availability gate: never show a number we can't stand behind. ---
  let profitabilityAvailable = true;
  let unavailableReason: string | null = null;

  if (revenue === 0 && costs === 0) {
    profitabilityAvailable = false;
    unavailableReason = "No revenue or cost data recorded for this job yet.";
  } else if (revenue > 0 && costs === 0) {
    profitabilityAvailable = false;
    unavailableReason = "Profitability unavailable — cost data incomplete.";
    flags.push("revenue_no_costs");
  } else if (revenue === 0 && costs > 0) {
    profitabilityAvailable = false;
    unavailableReason = "Costs recorded but no revenue yet — profitability unavailable.";
    flags.push("costs_no_revenue");
  }

  let grossProfit: number | null = null;
  let grossMarginPct: number | null = null;
  let fullyLoadedProfit: number | null = null;
  let fullyLoadedMarginPct: number | null = null;

  if (profitabilityAvailable) {
    grossProfit = revenue - costs;
    grossMarginPct = revenue > 0 ? grossProfit / revenue : null;

    if (ctx.overheadEnabled && ctx.overheadMethod && ctx.overheadValue != null) {
      const overheadAllocated =
        ctx.overheadMethod === "pct_of_revenue" ? revenue * ctx.overheadValue : costs * ctx.overheadValue;
      fullyLoadedProfit = grossProfit - overheadAllocated;
      fullyLoadedMarginPct = revenue > 0 ? fullyLoadedProfit / revenue : null;
    }

    if (targetMarginPct != null && grossMarginPct != null && grossMarginPct * 100 < targetMarginPct) {
      flags.push("below_target_margin");
    }
  }

  // --- Estimate variance (independent of the availability gate above - an
  // estimate can exist even when we can't yet compute profitability, and
  // vice versa). ---
  const estimatedCost = job.estimatedCost;
  const varianceVsEstimate = estimatedCost == null ? null : costs - estimatedCost;
  const varianceVsEstimatePct =
    estimatedCost != null && estimatedCost !== 0 && varianceVsEstimate != null
      ? varianceVsEstimate / estimatedCost
      : null;

  if (estimatedCost == null) flags.push("no_estimate_on_file");
  if (varianceVsEstimatePct != null && varianceVsEstimatePct > 0.1) flags.push("over_budget_10pct_plus");
  if (job.status === "open" && job.endDate && job.endDate < ctx.now) flags.push("past_end_date_still_open");

  const daysSinceActivity = lastFinancialActivity
    ? (ctx.now.getTime() - lastFinancialActivity.getTime()) / (1000 * 60 * 60 * 24)
    : null;
  if (job.status === "open" && (daysSinceActivity == null || daysSinceActivity > 30)) {
    flags.push("stale_job");
  }

  // --- Data Confidence ladder. Deterministic rules only - see comments for
  // exactly why a level was assigned, per the "no false precision" / "show
  // exactly why confidence is reduced" requirements. ---
  const confidenceReasons: string[] = [];
  let dataConfidence: DataConfidence;

  if (!profitabilityAvailable) {
    dataConfidence = "insufficient_data";
    confidenceReasons.push(unavailableReason!);
  } else {
    const categoriesPresent = Object.keys(costByCategory).length;
    const syncStale = ctx.lastSyncedAt
      ? (ctx.now.getTime() - ctx.lastSyncedAt.getTime()) / (1000 * 60 * 60 * 24) > 14
      : true;
    const hasEstimate = estimatedCost != null;

    if (hasEstimate && !syncStale && categoriesPresent >= 2) {
      dataConfidence = "high";
    } else if (!hasEstimate && (syncStale || categoriesPresent <= 1)) {
      dataConfidence = "low";
      if (!hasEstimate) confidenceReasons.push("No cost estimate on file for this job.");
      if (syncStale) confidenceReasons.push("QuickBooks data hasn't synced in over 14 days.");
      if (categoriesPresent <= 1) confidenceReasons.push("Costs are only recorded in one category so far.");
    } else {
      dataConfidence = "medium";
      if (!hasEstimate) confidenceReasons.push("No cost estimate on file for this job.");
      if (syncStale) confidenceReasons.push("QuickBooks data hasn't synced in over 14 days.");
      if (categoriesPresent <= 1) confidenceReasons.push("Costs are only recorded in one category so far.");
    }
  }

  return {
    jobId: job.id,
    jobName: job.name,
    customerName: job.customerName,
    status: job.status,
    category: job.category,
    revenue,
    estimatedRevenue: job.estimatedRevenue,
    costs,
    estimatedCost,
    costByCategory,
    profitabilityAvailable,
    unavailableReason,
    grossProfit,
    grossMarginPct,
    fullyLoadedProfit,
    fullyLoadedMarginPct,
    targetMarginPct: targetMarginPct ?? null,
    varianceVsEstimate,
    varianceVsEstimatePct,
    dataConfidence,
    confidenceReasons,
    lastFinancialActivity,
    flags,
  };
}

export interface NeedsAttentionItem {
  jobId: string;
  jobName: string;
  issueCode: string;
  issue: string;
  financialImpact: number | null;
  severity: "high" | "medium" | "low";
  confidence: "high" | "medium" | "low";
}

/**
 * Deterministic rule set for one job's "Needs Attention" findings.
 * `priorMarginPcts` (oldest-first) is optional trend data sourced from past
 * WeeklyDigest snapshots by the caller - the "margin declining" rule simply
 * doesn't fire without at least two prior data points, rather than guessing.
 * `peerCompletedCosts` is the same job's category costs from other completed
 * jobs of the same `category`, used only for the outlier rule, and only when
 * there are at least 3 comparable jobs (avoids calling a sample of one an
 * "outlier").
 */
export function computeNeedsAttentionForJob(
  f: JobFinancials,
  opts: {
    priorMarginPcts?: number[];
    peerCompletedCostByCategory?: Record<string, number[]>; // category -> list of totals from peer completed jobs
  } = {}
): NeedsAttentionItem[] {
  const items: NeedsAttentionItem[] = [];

  if (f.flags.includes("revenue_no_costs")) {
    items.push({
      jobId: f.jobId,
      jobName: f.jobName,
      issueCode: "revenue_no_costs",
      issue: "Revenue recorded but no costs assigned to this job",
      financialImpact: null,
      severity: "medium",
      confidence: "high", // the data gap itself is a fact, not an estimate
    });
  }

  if (f.flags.includes("costs_no_revenue") && f.status === "closed") {
    items.push({
      jobId: f.jobId,
      jobName: f.jobName,
      issueCode: "costs_no_revenue_completed",
      issue: "Job is marked completed but has no recorded revenue",
      financialImpact: null,
      severity: "high",
      confidence: "high",
    });
  }

  if (f.flags.includes("no_estimate_on_file")) {
    items.push({
      jobId: f.jobId,
      jobName: f.jobName,
      issueCode: "no_estimate_on_file",
      issue: "No cost estimate on file — can't track budget variance",
      financialImpact: null,
      severity: "low",
      confidence: "high",
    });
  }

  if (f.flags.includes("below_target_margin") && f.grossMarginPct != null && f.targetMarginPct != null) {
    const gapPct = f.targetMarginPct - f.grossMarginPct * 100;
    items.push({
      jobId: f.jobId,
      jobName: f.jobName,
      issueCode: "below_target_margin",
      issue: `Margin is ${gapPct.toFixed(1)} points below your ${f.targetMarginPct}% target`,
      financialImpact: f.revenue > 0 ? f.revenue * (gapPct / 100) : null,
      severity: gapPct > 10 ? "high" : gapPct > 5 ? "medium" : "low",
      confidence: "high",
    });
  }

  if (f.flags.includes("over_budget_10pct_plus") && f.varianceVsEstimate != null && f.varianceVsEstimatePct != null) {
    items.push({
      jobId: f.jobId,
      jobName: f.jobName,
      issueCode: "over_budget",
      issue: `Actual costs are ${(f.varianceVsEstimatePct * 100).toFixed(0)}% over the estimate`,
      financialImpact: f.varianceVsEstimate,
      severity: f.varianceVsEstimatePct > 0.25 ? "high" : "medium",
      confidence: "high",
    });
  }

  if (f.flags.includes("stale_job")) {
    items.push({
      jobId: f.jobId,
      jobName: f.jobName,
      issueCode: "stale_job",
      issue: "No financial activity synced on this open job in over 30 days",
      financialImpact: null,
      severity: "low",
      confidence: "high",
    });
  }

  // Margin declining: needs at least 2 prior data points, most recent first
  // when reversed - only fires on a real downward trend, not noise from one
  // data point.
  const priors = opts.priorMarginPcts ?? [];
  if (priors.length >= 2 && f.grossMarginPct != null) {
    const trend = [...priors, f.grossMarginPct];
    const isDeclining = trend.every((v, i) => i === 0 || v <= trend[i - 1]);
    if (isDeclining && trend[trend.length - 1] < trend[0]) {
      items.push({
        jobId: f.jobId,
        jobName: f.jobName,
        issueCode: "margin_declining",
        issue: "Margin has declined over the last several digests",
        financialImpact: null,
        severity: "medium",
        confidence: priors.length >= 3 ? "high" : "medium",
      });
    }
  }

  // Cost outlier vs. same-category completed jobs: only when >=3 peers exist
  // per category, and only flags categories >50% above the peer median.
  const peers = opts.peerCompletedCostByCategory ?? {};
  for (const [category, amount] of Object.entries(f.costByCategory)) {
    const peerAmounts = peers[category];
    if (!peerAmounts || peerAmounts.length < 3) continue;
    const sorted = [...peerAmounts].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    if (median > 0 && amount > median * 1.5) {
      items.push({
        jobId: f.jobId,
        jobName: f.jobName,
        issueCode: "cost_outlier",
        issue: `${category[0].toUpperCase()}${category.slice(1)} cost is unusually high vs. similar completed jobs`,
        financialImpact: amount - median,
        severity: "medium",
        confidence: peerAmounts.length >= 5 ? "high" : "medium",
      });
    }
  }

  return items;
}

export interface ForecastResult {
  available: boolean;
  reason?: string;
  actualCostToDate?: number;
  estimatedCost?: number;
  forecastCostAtCompletion?: number;
  forecastProfit?: number;
  forecastMarginPct?: number;
  confidence?: "high" | "medium" | "low";
}

/**
 * Forecast-at-completion for an in-progress job. Requires an estimate/budget,
 * actual costs, AND a defensible progress signal (recent cost activity) -
 * never built from revenue and current costs alone per spec.
 */
export function computeForecastAtCompletion(job: JobInput, f: JobFinancials, now: Date): ForecastResult {
  if (job.status !== "open") {
    return { available: false, reason: "Not enough data to create a reliable forecast." };
  }
  if (f.estimatedCost == null || f.estimatedCost <= 0) {
    return { available: false, reason: "Not enough data to create a reliable forecast." };
  }
  if (f.costs <= 0) {
    return { available: false, reason: "Not enough data to create a reliable forecast." };
  }
  const daysSinceActivity = f.lastFinancialActivity
    ? (now.getTime() - f.lastFinancialActivity.getTime()) / (1000 * 60 * 60 * 24)
    : Infinity;
  if (daysSinceActivity > 30) {
    return { available: false, reason: "Not enough data to create a reliable forecast." };
  }

  // Simple, transparent run-rate model: cost overrun rate observed so far
  // (actual / estimate) projected onto the full estimate. Deliberately not a
  // time-based projection (spec explicitly forbids revenue+current-cost-only
  // forecasts) - this uses the estimate as the completion baseline and scales
  // it by the variance already observed, which is defensible with an
  // estimate + real cost data in hand.
  const overrunRate = f.costs / f.estimatedCost;
  const forecastCostAtCompletion = f.estimatedCost * Math.max(overrunRate, 1);
  const forecastProfit = (f.estimatedRevenue ?? f.revenue) - forecastCostAtCompletion;
  const forecastMarginPct =
    (f.estimatedRevenue ?? f.revenue) > 0 ? forecastProfit / (f.estimatedRevenue ?? f.revenue) : null;

  const costCoveragePct = f.costs / f.estimatedCost;
  const confidence: "high" | "medium" | "low" =
    costCoveragePct >= 0.5 ? "high" : costCoveragePct >= 0.2 ? "medium" : "low";

  return {
    available: true,
    actualCostToDate: f.costs,
    estimatedCost: f.estimatedCost,
    forecastCostAtCompletion,
    forecastProfit,
    forecastMarginPct: forecastMarginPct ?? undefined,
    confidence,
  };
}

export interface ProfitLeakageStep {
  label: string;
  value: number; // isTotal steps: the running total at that point. delta steps: the signed change (positive helps profit, negative hurts it).
  isTotal: boolean;
}

/**
 * Profit Leakage / Variance bridge for one job (Chart 4): the movement from
 * expected profit to actual/forecast profit. Only includes steps that are
 * directly computable from real data - per spec ("do not fabricate leakage
 * categories"), this does NOT break cost variance down by category, because
 * we only have one total estimatedCost (not a per-category budget) - splitting
 * that single number across categories would be inventing a breakdown the
 * data doesn't support. Returns null when there isn't a real estimate to
 * bridge from (nothing to show instead of a misleading chart).
 */
export function computeProfitLeakage(f: JobFinancials, forecast: ForecastResult): ProfitLeakageStep[] | null {
  if (f.estimatedCost == null || f.estimatedRevenue == null) return null;

  const expectedProfit = f.estimatedRevenue - f.estimatedCost;
  const revenueVariance = f.revenue - f.estimatedRevenue; // more actual revenue than quoted = helps profit
  const costVariance = f.estimatedCost - f.costs; // spent less than estimated = helps profit (positive)

  const steps: ProfitLeakageStep[] = [
    { label: "Expected profit", value: expectedProfit, isTotal: true },
    { label: "Revenue vs. estimate", value: revenueVariance, isTotal: false },
    { label: "Cost vs. estimate", value: costVariance, isTotal: false },
  ];

  if (f.fullyLoadedProfit != null && f.grossProfit != null) {
    steps.push({ label: "Overhead allocation", value: f.fullyLoadedProfit - f.grossProfit, isTotal: false });
  }

  const runningTotal = steps.reduce((s, step) => (step.isTotal ? step.value : s + step.value), 0);
  const endLabel = f.status === "open" && forecast.available ? "Forecast profit" : "Actual profit";
  const endValue =
    f.status === "open" && forecast.available && forecast.forecastProfit != null
      ? forecast.forecastProfit
      : f.fullyLoadedProfit ?? f.grossProfit ?? runningTotal;
  steps.push({ label: endLabel, value: endValue, isTotal: true });

  return steps;
}

export interface DataHealthReport {
  jobsMissingEstimates: { jobId: string; jobName: string }[];
  jobsMissingCosts: { jobId: string; jobName: string }[];
  staleJobs: { jobId: string; jobName: string; daysSinceActivity: number }[];
  completedJobsWithUnresolvedActivity: { jobId: string; jobName: string }[];
  unassignedExpenseCount: number | null; // null = not yet measured (needs a sync with unassigned-expense tracking, see sync route Phase 2)
  unassignedExpenseAmount: number | null;
  possibleDuplicates: { jobName: string; amount: number; date: string; jobId: string }[];
  overallConfidence: DataConfidence;
}

/**
 * Company-level rollup of data-quality issues. Pure aggregation over already-
 * computed JobFinancials plus whatever the latest SyncRun recorded about
 * unassigned expenses (see plan §3 - that tracking lands in the sync-route
 * Phase 2 work; until then this just reports "not yet measured" rather than 0,
 * which would misleadingly imply there are none).
 */
export function computeDataHealth(
  jobs: JobFinancials[],
  now: Date,
  latestSyncEntitiesUpdated: Record<string, unknown> | null
): DataHealthReport {
  const jobsMissingEstimates = jobs
    .filter((j) => j.estimatedCost == null)
    .map((j) => ({ jobId: j.jobId, jobName: j.jobName }));

  const jobsMissingCosts = jobs
    .filter((j) => j.revenue > 0 && j.costs === 0)
    .map((j) => ({ jobId: j.jobId, jobName: j.jobName }));

  const staleJobs = jobs
    .filter((j) => j.status === "open" && j.flags.includes("stale_job"))
    .map((j) => ({
      jobId: j.jobId,
      jobName: j.jobName,
      daysSinceActivity: j.lastFinancialActivity
        ? Math.round((now.getTime() - j.lastFinancialActivity.getTime()) / (1000 * 60 * 60 * 24))
        : Infinity,
    }));

  const completedJobsWithUnresolvedActivity = jobs
    .filter((j) => j.status === "closed" && (j.flags.includes("revenue_no_costs") || j.flags.includes("costs_no_revenue")))
    .map((j) => ({ jobId: j.jobId, jobName: j.jobName }));

  const unassignedExpenseCount =
    typeof latestSyncEntitiesUpdated?.unassignedExpenseCount === "number"
      ? (latestSyncEntitiesUpdated.unassignedExpenseCount as number)
      : null;
  const unassignedExpenseAmount =
    typeof latestSyncEntitiesUpdated?.unassignedExpenseAmount === "number"
      ? (latestSyncEntitiesUpdated.unassignedExpenseAmount as number)
      : null;

  // Possible duplicate: same job, same amount, same date, but we only ever
  // store one CostEntry per (source type, source id) via upsert - so a true
  // duplicate here means two *different* QBO transactions landed with
  // identical job/amount/date, which is worth a human glance, not an
  // auto-merge.
  // Possible-duplicate detection needs raw CostEntry rows (source ids, exact
  // dates) that aren't part of JobFinancials - the async wrapper below
  // computes this separately and merges it in, since this function only
  // receives already-aggregated per-job financials.
  const possibleDuplicates: DataHealthReport["possibleDuplicates"] = [];

  const insufficientCount = jobs.filter((j) => j.dataConfidence === "insufficient_data").length;
  const overallConfidence: DataConfidence =
    jobs.length === 0
      ? "insufficient_data"
      : insufficientCount / jobs.length > 0.5
      ? "low"
      : insufficientCount / jobs.length > 0.2
      ? "medium"
      : "high";

  return {
    jobsMissingEstimates,
    jobsMissingCosts,
    staleJobs,
    completedJobsWithUnresolvedActivity,
    unassignedExpenseCount,
    unassignedExpenseAmount,
    possibleDuplicates,
    overallConfidence,
  };
}

export interface ProfitOpportunity {
  type: string;
  title: string;
  description: string;
  financialImpact: number | null;
  confidence: "high" | "medium" | "low";
  supportingJobIds: string[];
}

/**
 * Cross-job pattern rollups. Pure aggregation over JobFinancials only - no
 * new data source, and every dollar figure shown is a sum/average of numbers
 * computeJobFinancials already produced, with the calculation exposed in
 * `description` so it's auditable rather than a black box.
 */
export function computeProfitOpportunities(jobs: JobFinancials[]): ProfitOpportunity[] {
  const opportunities: ProfitOpportunity[] = [];
  const completed = jobs.filter((j) => j.status === "closed" && j.profitabilityAvailable);

  // Recurring underestimation by category (>=3 completed jobs in a category, avg overrun >10%)
  const byCategory: Record<string, JobFinancials[]> = {};
  for (const j of completed) {
    if (!j.category || j.varianceVsEstimatePct == null) continue;
    (byCategory[j.category] ??= []).push(j);
  }
  for (const [category, catJobs] of Object.entries(byCategory)) {
    if (catJobs.length < 3) continue;
    const avgOverrunPct =
      catJobs.reduce((s, j) => s + (j.varianceVsEstimatePct ?? 0), 0) / catJobs.length;
    if (avgOverrunPct > 0.1) {
      const avgDollarImpact =
        catJobs.reduce((s, j) => s + (j.varianceVsEstimate ?? 0), 0) / catJobs.length;
      opportunities.push({
        type: "recurring_underestimation",
        title: `${category[0].toUpperCase()}${category.slice(1)} jobs consistently run over estimate`,
        description: `Across the last ${catJobs.length} completed ${category} jobs, actual costs averaged ${(avgOverrunPct * 100).toFixed(1)}% above estimate (avg $${Math.round(avgDollarImpact).toLocaleString()} over per job).`,
        financialImpact: avgDollarImpact * catJobs.length,
        confidence: catJobs.length >= 5 ? "high" : "medium",
        supportingJobIds: catJobs.map((j) => j.jobId),
      });
    }
  }

  // Consistently low-margin category
  for (const [category, catJobs] of Object.entries(byCategory)) {
    const withMargin = catJobs.filter((j) => j.grossMarginPct != null && j.targetMarginPct != null);
    if (withMargin.length < 3) continue;
    const belowTarget = withMargin.filter((j) => (j.grossMarginPct! * 100) < j.targetMarginPct!);
    if (belowTarget.length / withMargin.length >= 0.6) {
      opportunities.push({
        type: "low_margin_category",
        title: `${category[0].toUpperCase()}${category.slice(1)} jobs frequently miss target margin`,
        description: `${belowTarget.length} of ${withMargin.length} completed ${category} jobs came in below target margin.`,
        financialImpact: null,
        confidence: withMargin.length >= 5 ? "high" : "medium",
        supportingJobIds: belowTarget.map((j) => j.jobId),
      });
    }
  }

  // High-performing category worth pursuing more
  for (const [category, catJobs] of Object.entries(byCategory)) {
    const withMargin = catJobs.filter((j) => j.grossMarginPct != null);
    if (withMargin.length < 3) continue;
    const avgMargin = withMargin.reduce((s, j) => s + j.grossMarginPct!, 0) / withMargin.length;
    const overallAvg =
      completed.filter((j) => j.grossMarginPct != null).reduce((s, j) => s + j.grossMarginPct!, 0) /
      Math.max(completed.filter((j) => j.grossMarginPct != null).length, 1);
    if (avgMargin > overallAvg * 1.25 && avgMargin > 0) {
      opportunities.push({
        type: "high_performing_category",
        title: `${category[0].toUpperCase()}${category.slice(1)} jobs outperform your average`,
        description: `${category[0].toUpperCase()}${category.slice(1)} jobs averaged ${(avgMargin * 100).toFixed(1)}% margin vs. ${(overallAvg * 100).toFixed(1)}% company-wide across ${withMargin.length} completed jobs.`,
        financialImpact: null,
        confidence: withMargin.length >= 5 ? "high" : "medium",
        supportingJobIds: withMargin.map((j) => j.jobId),
      });
    }
  }

  return opportunities;
}

export interface DashboardTotals {
  activeJobs: number;
  revenue: number;
  trackedJobCosts: number;
  jobGrossProfit: number;
  avgJobMarginPct: number | null;
  targetMarginPct: number | null;
  jobsBelowTarget: number;
  profitAtRisk: number; // sum of the dollar gap between actual and target margin, for jobs below target
  dataIssues: number;
}

/**
 * The KPI row at the top of the Profit Dashboard. Pure aggregation over
 * already-computed JobFinancials/NeedsAttentionItems/DataHealthReport - every
 * number here is a sum/average of numbers computed elsewhere, nothing new is
 * calculated in this function beyond addition and division.
 */
export function computeDashboardTotals(
  jobs: JobFinancials[],
  needsAttention: NeedsAttentionItem[],
  dataHealth: DataHealthReport,
  targetMarginPct: number | null
): DashboardTotals {
  const activeJobs = jobs.filter((j) => j.status === "open").length;
  const revenue = jobs.reduce((s, j) => s + j.revenue, 0);
  const trackedJobCosts = jobs.reduce((s, j) => s + j.costs, 0);
  const jobGrossProfit = revenue - trackedJobCosts;

  const withMargin = jobs.filter((j) => j.grossMarginPct != null);
  const avgJobMarginPct =
    withMargin.length > 0 ? withMargin.reduce((s, j) => s + j.grossMarginPct!, 0) / withMargin.length : null;

  const jobsBelowTarget = jobs.filter((j) => j.flags.includes("below_target_margin")).length;
  const profitAtRisk = needsAttention
    .filter((i) => i.issueCode === "below_target_margin")
    .reduce((s, i) => s + (i.financialImpact ?? 0), 0);

  const dataIssues =
    dataHealth.jobsMissingEstimates.length +
    dataHealth.jobsMissingCosts.length +
    dataHealth.staleJobs.length +
    dataHealth.completedJobsWithUnresolvedActivity.length +
    (dataHealth.unassignedExpenseCount ?? 0) +
    dataHealth.possibleDuplicates.length;

  return {
    activeJobs,
    revenue,
    trackedJobCosts,
    jobGrossProfit,
    avgJobMarginPct,
    targetMarginPct,
    jobsBelowTarget,
    profitAtRisk,
    dataIssues,
  };
}

// ============================================================================
// ASYNC WRAPPERS - Prisma fetch + call into the pure layer above.
// ============================================================================

const toNum = (d: Prisma.Decimal | null | undefined): number => (d == null ? 0 : Number(d));

/**
 * Flags cost entries that share a job, amount, and calendar day but came from
 * *different* QBO source transactions (qboSourceId) - the upsert in the sync
 * route already prevents storing the same source transaction twice, so a hit
 * here means two distinct QBO transactions landed with identical numbers,
 * worth a human glance rather than an automatic merge (per spec: flag, don't
 * auto-merge).
 */
function findPossibleDuplicateCostEntries(
  jobs: {
    id: string;
    name: string;
    costEntries: { qboSourceId: string; amount: Prisma.Decimal; txnDate: Date }[];
  }[]
): DataHealthReport["possibleDuplicates"] {
  const duplicates: DataHealthReport["possibleDuplicates"] = [];
  for (const job of jobs) {
    const seen = new Map<string, Set<string>>(); // key: amount|day -> set of qboSourceIds
    for (const entry of job.costEntries) {
      const amount = toNum(entry.amount);
      const day = entry.txnDate.toISOString().slice(0, 10);
      const key = `${amount}|${day}`;
      const sourceIds = seen.get(key) ?? new Set<string>();
      const wasAlreadyFlagged = sourceIds.size > 1;
      sourceIds.add(entry.qboSourceId);
      seen.set(key, sourceIds);
      if (sourceIds.size > 1 && !wasAlreadyFlagged) {
        duplicates.push({ jobId: job.id, jobName: job.name, amount, date: day });
      }
    }
  }
  return duplicates;
}

export interface DateRange {
  from: Date;
  to: Date;
}

export type JobStatusFilter = "open" | "closed" | "all";

export interface ConnectionProfitData {
  connectionId: string;
  jobs: JobFinancials[];
  needsAttention: NeedsAttentionItem[];
  dataHealth: DataHealthReport;
  opportunities: ProfitOpportunity[];
  totals: DashboardTotals;
  targetMarginPct: number | null;
}

/**
 * Reads the last few WeeklyDigest snapshots for this connection and returns,
 * per job, its margin history oldest-first (excluding the current moment -
 * this is prior data only). Powers the "margin declining" Needs Attention
 * rule. Digests are only generated when the user or the weekly cron runs one,
 * so this is naturally sparse early on - computeNeedsAttentionForJob already
 * requires >=2 points before the rule fires, so sparse data just means the
 * rule doesn't fire yet rather than firing on noise.
 */
async function getPriorMarginsByJob(connectionId: string, limit = 6): Promise<Record<string, number[]>> {
  const digests = await prisma.weeklyDigest.findMany({
    where: { connectionId },
    orderBy: { weekStarting: "asc" },
    take: limit,
  });
  const byJob: Record<string, number[]> = {};
  for (const digest of digests) {
    const metrics = digest.metrics as unknown as { jobs?: { jobId: string; marginPct: number | null }[] };
    for (const j of metrics?.jobs ?? []) {
      if (j.marginPct == null) continue;
      (byJob[j.jobId] ??= []).push(j.marginPct);
    }
  }
  return byJob;
}

/**
 * The main entry point pages/routes call. Fetches everything needed, builds
 * the FinancialContext, and runs it through the pure calculation layer above.
 * `dateRange` limits which cost/invoice transactions count toward each job's
 * totals (for the dashboard's date filter); `statusFilter` limits which jobs
 * are included at all. Both default to "everything" when omitted.
 */
export async function getConnectionProfitData(
  connectionId: string,
  now: Date = new Date(),
  options: { dateRange?: DateRange; statusFilter?: JobStatusFilter } = {}
): Promise<ConnectionProfitData> {
  const { dateRange, statusFilter = "all" } = options;

  const connection = await prisma.quickBooksConnection.findUniqueOrThrow({
    where: { id: connectionId },
    include: { marginTargets: true },
  });

  const jobs = await prisma.job.findMany({
    where: {
      connectionId,
      ...(statusFilter !== "all" ? { status: statusFilter } : {}),
    },
    include: { costEntries: true, invoices: true },
  });

  const categoryTargetMarginPct: Record<string, number> = {};
  for (const mt of connection.marginTargets) {
    categoryTargetMarginPct[mt.category] = toNum(mt.targetPct);
  }

  const ctx: FinancialContext = {
    now,
    targetMarginPct: connection.targetMarginPct == null ? null : toNum(connection.targetMarginPct),
    categoryTargetMarginPct,
    overheadEnabled: connection.overheadEnabled,
    overheadMethod: connection.overheadMethod as FinancialContext["overheadMethod"],
    overheadValue: connection.overheadValue == null ? null : toNum(connection.overheadValue),
    lastSyncedAt: connection.lastSyncedAt,
  };

  const inRange = (d: Date) => !dateRange || (d >= dateRange.from && d <= dateRange.to);

  const jobInputs: JobInput[] = jobs.map((j) => ({
    id: j.id,
    name: j.name,
    customerName: j.customerName,
    status: j.status,
    category: j.category,
    estimatedRevenue: j.estimatedRevenue == null ? null : toNum(j.estimatedRevenue),
    estimatedCost: j.estimatedCost == null ? null : toNum(j.estimatedCost),
    startDate: j.startDate,
    endDate: j.endDate,
    updatedAt: j.updatedAt,
    costEntries: j.costEntries
      .filter((c) => inRange(c.txnDate))
      .map((c) => ({ category: c.category, amount: toNum(c.amount), txnDate: c.txnDate })),
    invoices: j.invoices
      .filter((i) => inRange(i.txnDate))
      .map((i) => ({ amount: toNum(i.amount), status: i.status, txnDate: i.txnDate })),
  }));

  const financials = jobInputs.map((j) => computeJobFinancials(j, ctx));

  const latestSync = await prisma.syncRun.findFirst({
    where: { connectionId, status: "success" },
    orderBy: { startedAt: "desc" },
  });

  const dataHealth = computeDataHealth(
    financials,
    now,
    (latestSync?.entitiesUpdated as Record<string, unknown> | null) ?? null
  );
  dataHealth.possibleDuplicates = findPossibleDuplicateCostEntries(jobs);

  const opportunities = computeProfitOpportunities(financials);

  // Needs Attention: per-job rule evaluation, with prior-margin trend data
  // and same-category peer costs (completed jobs only) threaded in.
  const priorMarginsByJob = await getPriorMarginsByJob(connectionId);
  const completedByCategory: Record<string, JobFinancials[]> = {};
  for (const f of financials) {
    if (f.status === "closed" && f.category) (completedByCategory[f.category] ??= []).push(f);
  }
  const needsAttention = financials.flatMap((f) => {
    const peerCompletedCostByCategory: Record<string, number[]> = {};
    if (f.category && completedByCategory[f.category]) {
      for (const peer of completedByCategory[f.category]) {
        if (peer.jobId === f.jobId) continue;
        for (const [cat, amt] of Object.entries(peer.costByCategory)) {
          (peerCompletedCostByCategory[cat] ??= []).push(amt);
        }
      }
    }
    return computeNeedsAttentionForJob(f, {
      priorMarginPcts: priorMarginsByJob[f.jobId],
      peerCompletedCostByCategory,
    });
  });

  const totals = computeDashboardTotals(financials, needsAttention, dataHealth, ctx.targetMarginPct);

  return {
    connectionId,
    jobs: financials,
    needsAttention,
    dataHealth,
    opportunities,
    totals,
    targetMarginPct: ctx.targetMarginPct,
  };
}

export interface MarginTrendPoint {
  period: string; // "2026-01" (monthly) or "2026-Q1" (quarterly)
  revenue: number;
  costs: number;
  marginPct: number | null;
}

/**
 * Average margin across completed jobs over time (Chart 3). Buckets actual
 * revenue/cost transactions by the month or quarter they landed in - built
 * directly from CostEntry/InvoiceSummary transaction dates (data already
 * being synced), not from any new data source.
 */
export async function getMarginTrend(
  connectionId: string,
  granularity: "monthly" | "quarterly"
): Promise<MarginTrendPoint[]> {
  const jobs = await prisma.job.findMany({
    where: { connectionId, status: "closed" },
    include: { costEntries: true, invoices: true },
  });

  const periodKey = (d: Date): string =>
    granularity === "monthly"
      ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`
      : `${d.getFullYear()}-Q${Math.floor(d.getMonth() / 3) + 1}`;

  const buckets = new Map<string, { revenue: number; costs: number }>();
  for (const job of jobs) {
    for (const inv of job.invoices) {
      const key = periodKey(inv.txnDate);
      const b = buckets.get(key) ?? { revenue: 0, costs: 0 };
      b.revenue += toNum(inv.amount);
      buckets.set(key, b);
    }
    for (const c of job.costEntries) {
      const key = periodKey(c.txnDate);
      const b = buckets.get(key) ?? { revenue: 0, costs: 0 };
      b.costs += toNum(c.amount);
      buckets.set(key, b);
    }
  }

  return Array.from(buckets.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([period, { revenue, costs }]) => ({
      period,
      revenue,
      costs,
      marginPct: revenue > 0 ? (revenue - costs) / revenue : null,
    }));
}

export interface JobProfitData {
  connectionId: string;
  connectionUserId: string; // for the caller to verify ownership before returning any of this to a request
  companyName: string | null;
  financials: JobFinancials;
  forecast: ForecastResult;
  leakage: ProfitLeakageStep[] | null;
  needsAttention: NeedsAttentionItem[];
  priorMarginPcts: number[]; // oldest-first, from past WeeklyDigest snapshots - powers the Profit Trend section
  rawCostEntries: { id: string; category: string; description: string | null; amount: number; txnDate: Date; qboSourceType: string }[];
  rawInvoices: { id: string; amount: number; status: string; txnDate: Date }[];
}

/**
 * Single-job version of getConnectionProfitData, for the Job Detail page -
 * fetches only what one job's page needs (including raw transaction rows for
 * the Transactions section) rather than computing the whole connection's
 * job list and discarding all but one.
 */
export async function getJobProfitData(jobId: string, now: Date = new Date()): Promise<JobProfitData | null> {
  const job = await prisma.job.findUnique({
    where: { id: jobId },
    include: {
      costEntries: { orderBy: { txnDate: "desc" } },
      invoices: { orderBy: { txnDate: "desc" } },
      connection: { include: { marginTargets: true } },
    },
  });
  if (!job) return null;

  const connection = job.connection;
  const categoryTargetMarginPct: Record<string, number> = {};
  for (const mt of connection.marginTargets) {
    categoryTargetMarginPct[mt.category] = toNum(mt.targetPct);
  }

  const ctx: FinancialContext = {
    now,
    targetMarginPct: connection.targetMarginPct == null ? null : toNum(connection.targetMarginPct),
    categoryTargetMarginPct,
    overheadEnabled: connection.overheadEnabled,
    overheadMethod: connection.overheadMethod as FinancialContext["overheadMethod"],
    overheadValue: connection.overheadValue == null ? null : toNum(connection.overheadValue),
    lastSyncedAt: connection.lastSyncedAt,
  };

  const jobInput: JobInput = {
    id: job.id,
    name: job.name,
    customerName: job.customerName,
    status: job.status,
    category: job.category,
    estimatedRevenue: job.estimatedRevenue == null ? null : toNum(job.estimatedRevenue),
    estimatedCost: job.estimatedCost == null ? null : toNum(job.estimatedCost),
    startDate: job.startDate,
    endDate: job.endDate,
    updatedAt: job.updatedAt,
    costEntries: job.costEntries.map((c) => ({ category: c.category, amount: toNum(c.amount), txnDate: c.txnDate })),
    invoices: job.invoices.map((i) => ({ amount: toNum(i.amount), status: i.status, txnDate: i.txnDate })),
  };

  const financials = computeJobFinancials(jobInput, ctx);
  const forecast = computeForecastAtCompletion(jobInput, financials, now);
  const leakage = computeProfitLeakage(financials, forecast);

  // Peer costs for the outlier rule: other completed jobs in the same category, same connection.
  let peerCompletedCostByCategory: Record<string, number[]> = {};
  if (job.category) {
    const peers = await prisma.job.findMany({
      where: { connectionId: connection.id, category: job.category, status: "closed", id: { not: job.id } },
      include: { costEntries: true, invoices: true },
    });
    for (const peer of peers) {
      const peerInput: JobInput = {
        id: peer.id,
        name: peer.name,
        customerName: peer.customerName,
        status: peer.status,
        category: peer.category,
        estimatedRevenue: peer.estimatedRevenue == null ? null : toNum(peer.estimatedRevenue),
        estimatedCost: peer.estimatedCost == null ? null : toNum(peer.estimatedCost),
        startDate: peer.startDate,
        endDate: peer.endDate,
        updatedAt: peer.updatedAt,
        costEntries: peer.costEntries.map((c) => ({ category: c.category, amount: toNum(c.amount), txnDate: c.txnDate })),
        invoices: peer.invoices.map((i) => ({ amount: toNum(i.amount), status: i.status, txnDate: i.txnDate })),
      };
      const peerFinancials = computeJobFinancials(peerInput, ctx);
      for (const [cat, amt] of Object.entries(peerFinancials.costByCategory)) {
        (peerCompletedCostByCategory[cat] ??= []).push(amt);
      }
    }
  }
  const priorMarginsByJob = await getPriorMarginsByJob(connection.id);
  const needsAttention = computeNeedsAttentionForJob(financials, {
    priorMarginPcts: priorMarginsByJob[job.id],
    peerCompletedCostByCategory,
  });

  return {
    connectionId: connection.id,
    connectionUserId: connection.userId,
    companyName: connection.companyName,
    financials,
    forecast,
    leakage,
    needsAttention,
    priorMarginPcts: priorMarginsByJob[job.id] ?? [],
    rawCostEntries: job.costEntries.map((c) => ({
      id: c.id,
      category: c.category,
      description: c.description,
      amount: toNum(c.amount),
      txnDate: c.txnDate,
      qboSourceType: c.qboSourceType,
    })),
    rawInvoices: job.invoices.map((i) => ({ id: i.id, amount: toNum(i.amount), status: i.status, txnDate: i.txnDate })),
  };
}

// ============================================================================
// LEGACY ADAPTER - keeps src/lib/digest.ts working unchanged for now. The
// digest generator is rewired onto the richer engine above in a later phase
// (see plan §3/§9 Phase 4) alongside the Data-Health-aware email logic; until
// then this preserves the exact shape ConnectionMetrics/JobMetrics already had.
// ============================================================================

export interface JobMetrics {
  jobId: string;
  jobName: string;
  customerName: string | null;
  status: string;
  estimatedCost: number | null;
  actualCost: number;
  estimatedRevenue: number | null;
  actualRevenue: number;
  costByCategory: Record<string, number>;
  marginPct: number | null;
  varianceVsEstimate: number | null;
  varianceVsEstimatePct: number | null;
  flags: string[];
}

export interface ConnectionMetrics {
  connectionId: string;
  weekStarting: Date;
  jobs: JobMetrics[];
  topConcerns: JobMetrics[];
  totals: {
    activeJobs: number;
    totalActualCost: number;
    totalActualRevenue: number;
    blendedMarginPct: number | null;
  };
}

export async function computeConnectionMetrics(connectionId: string, weekStarting: Date): Promise<ConnectionMetrics> {
  // `weekStarting` is a label (the Monday this digest is "for"), not "now" -
  // pass the real current time to the engine so staleness/date-based flags
  // are computed correctly regardless of which day of the week this runs on.
  const data = await getConnectionProfitData(connectionId, new Date());

  const jobMetrics: JobMetrics[] = data.jobs.map((f) => ({
    jobId: f.jobId,
    jobName: f.jobName,
    customerName: f.customerName,
    status: f.status,
    estimatedCost: f.estimatedCost,
    actualCost: f.costs,
    estimatedRevenue: f.estimatedRevenue,
    actualRevenue: f.revenue,
    costByCategory: f.costByCategory,
    marginPct: f.grossMarginPct,
    varianceVsEstimate: f.varianceVsEstimate,
    varianceVsEstimatePct: f.varianceVsEstimatePct,
    flags: f.flags,
  }));

  const topConcerns = [...jobMetrics]
    .filter((j) => j.flags.length > 0)
    .sort((a, b) => {
      if (b.flags.length !== a.flags.length) return b.flags.length - a.flags.length;
      return (b.varianceVsEstimate ?? 0) - (a.varianceVsEstimate ?? 0);
    })
    .slice(0, 5);

  const activeJobs = jobMetrics.filter((j) => j.status === "open").length;
  const totalActualCost = jobMetrics.reduce((s, j) => s + j.actualCost, 0);
  const totalActualRevenue = jobMetrics.reduce((s, j) => s + j.actualRevenue, 0);
  const blendedMarginPct = totalActualRevenue > 0 ? (totalActualRevenue - totalActualCost) / totalActualRevenue : null;

  return {
    connectionId,
    weekStarting,
    jobs: jobMetrics,
    topConcerns,
    totals: { activeJobs, totalActualCost, totalActualRevenue, blendedMarginPct },
  };
}
