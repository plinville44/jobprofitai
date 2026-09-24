import { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import { requireFeature } from "./entitlements";
import { effectiveJobStatus, CLOSED_JOB_WHERE, OPEN_JOB_WHERE, VISIBLE_JOB_WHERE } from "./jobStatus";

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
  /**
   * The job's contract value: typed in JobProfitAI if the contractor did,
   * otherwise from QuickBooks estimates. Named estimatedRevenue for history.
   */
  estimatedRevenue: number | null;
  estimatedCost: number | null;
  /** The contractor's own percent complete for an open job, 0-100. */
  percentCompleteOverride?: number | null;
  /** When the QuickBooks customer record was created. */
  qboCreatedAt?: Date | null;
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

  /**
   * True when the costs and invoices in JobInput have been filtered to a
   * date window (the dashboard's period picker) rather than being the job's
   * whole life.
   *
   * It exists because a job's estimate has no period. Comparing one month of
   * costs against a whole-job estimate is not a comparison, and it produced
   * the worst kind of wrong number: plausible. Pick "This month" on a job
   * costed at $12,000 that spent $600 in March and the variance read "95%
   * under the estimate" - a contractor's cue to bid lower next time.
   *
   * Everything that judges a job against its whole life is therefore
   * suppressed rather than recomputed on a slice: estimate variance, the
   * over-budget flag, and the staleness flag. Nothing here changes what the
   * period picker is for, which is the revenue, cost and margin totals.
   */
  costsAreWindowed?: boolean;
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
  /** When the QuickBooks customer record was created (idle-job detection). */
  qboCreatedAt: Date | null;

  /**
   * Work in progress, open jobs only, whole job only (null on a windowed
   * view and on completed jobs). See computeWip.
   */
  wip: WipFigures | null;

  flags: string[]; // machine-readable flags, consumed by computeNeedsAttentionForJob and legacy digest code
}

export interface WipFigures {
  /** 0-1. How far along the job is. */
  percentComplete: number;
  /** "manual" = the contractor's own figure; "cost" = cost to date / estimated cost. */
  percentCompleteSource: "manual" | "cost";
  /** Contract value x percent complete. */
  earnedRevenue: number;
  /** Billed minus earned. Positive = billed ahead of the work; negative = work done but not billed yet. */
  overUnderBilling: number;
  /** True when cost to date is already past the estimate, so cost can no longer measure progress. */
  costPastEstimate: boolean;
}

/**
 * Over/under billing for an open job, by the standard percent-complete
 * method contractors, their bookkeepers and their bonding companies use:
 *
 *   percent complete = the contractor's own figure, or cost to date / estimated cost
 *   earned revenue   = contract value x percent complete
 *   over/(under)     = billed to date - earned revenue
 *
 * Needs a contract value, and either a percent complete or an estimated
 * cost. When cost to date has passed the estimate, cost can no longer say
 * how far along the job is; percent complete is capped at 100% and the
 * figure is marked (costPastEstimate) so nobody reads it as "finished".
 */
export function computeWip(input: {
  contractValue: number | null;
  estimatedCost: number | null;
  costs: number;
  billed: number;
  percentCompleteOverride: number | null | undefined;
}): WipFigures | null {
  const { contractValue, estimatedCost, costs, billed } = input;
  if (contractValue == null || contractValue <= 0) return null;
  let percentComplete: number;
  let source: "manual" | "cost";
  let costPastEstimate = false;
  if (input.percentCompleteOverride != null && input.percentCompleteOverride >= 0) {
    percentComplete = Math.min(1, input.percentCompleteOverride / 100);
    source = "manual";
  } else if (estimatedCost != null && estimatedCost > 0) {
    const raw = costs / estimatedCost;
    costPastEstimate = raw > 1;
    percentComplete = Math.max(0, Math.min(1, raw));
    source = "cost";
  } else {
    return null;
  }
  const earnedRevenue = contractValue * percentComplete;
  return {
    percentComplete,
    percentCompleteSource: source,
    earnedRevenue,
    overUnderBilling: billed - earnedRevenue,
    costPastEstimate,
  };
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
    // Deliberately does not repeat "Profitability unavailable". The job
    // page prints that as a heading and then this string after it, so the
    // old wording rendered the sentence twice in a row. It still has to read
    // on its own, because it also goes into confidenceReasons below.
    unavailableReason = "Cost data incomplete. Revenue is recorded but no costs have been tagged to this job.";
    flags.push("revenue_no_costs");
  } else if (revenue === 0 && costs > 0) {
    profitabilityAvailable = false;
    unavailableReason = "Costs recorded but no revenue on this job yet.";
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

    // Completed jobs only. An open job's margin to date is mostly billing
    // timing: buy the materials before the next draw and it reads -30%,
    // bill a deposit first and it reads 90%. Open jobs are judged by their
    // forecast instead (see forecast_below_target in getConnectionProfitData).
    if (job.status !== "open" && targetMarginPct != null && grossMarginPct != null && grossMarginPct * 100 < targetMarginPct) {
      flags.push("below_target_margin");
    }
  }

  // --- Estimate variance (independent of the availability gate above - an
  // estimate can exist even when we can't yet compute profitability, and
  // vice versa). ---
  // An estimate covers the whole job, so it can only be compared against the
  // whole job's costs. See FinancialContext.costsAreWindowed.
  const estimatedCost = job.estimatedCost;
  const comparableToEstimate = !ctx.costsAreWindowed && estimatedCost != null;
  const varianceVsEstimate = comparableToEstimate ? costs - estimatedCost! : null;
  const varianceVsEstimatePct =
    comparableToEstimate && estimatedCost !== 0 && varianceVsEstimate != null
      ? varianceVsEstimate / estimatedCost!
      : null;

  // Still raised on a windowed view: whether an estimate EXISTS is a fact
  // about the job, not about the period, and Data Health counts on it.
  if (estimatedCost == null) flags.push("no_estimate_on_file");
  if (varianceVsEstimatePct != null && varianceVsEstimatePct > 0.1) flags.push("over_budget_10pct_plus");
  if (job.status === "open" && job.endDate && job.endDate < ctx.now) flags.push("past_end_date_still_open");

  const daysSinceActivity = lastFinancialActivity
    ? (ctx.now.getTime() - lastFinancialActivity.getTime()) / (1000 * 60 * 60 * 24)
    : null;
  // Not raised on a windowed view. "No activity in 30 days" read off a
  // one-month slice is circular: filter to March and every job that was
  // quiet in March looks abandoned.
  if (!ctx.costsAreWindowed && job.status === "open" && (daysSinceActivity == null || daysSinceActivity > 30)) {
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
    qboCreatedAt: job.qboCreatedAt ?? null,
    wip:
      job.status === "open" && !ctx.costsAreWindowed
        ? computeWip({
            contractValue: job.estimatedRevenue,
            estimatedCost,
            costs,
            billed: revenue,
            percentCompleteOverride: job.percentCompleteOverride,
          })
        : null,
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
    /** The job's forecast, when the plan includes forecasting and one is available. */
    forecast?: ForecastResult | null;
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

  // Open jobs only. An estimate still matters on a job in progress; asking
  // for one on every job finished years ago is noise nobody will act on.
  if (f.flags.includes("no_estimate_on_file") && f.status === "open") {
    items.push({
      jobId: f.jobId,
      jobName: f.jobName,
      issueCode: "no_estimate_on_file",
      issue: "No cost estimate on file. Can't track budget variance",
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

  // An open job heading below its target, judged on the forecast (Pro),
  // never on margin to date.
  const fc = opts.forecast;
  if (
    f.status === "open" &&
    f.targetMarginPct != null &&
    fc?.available &&
    fc.forecastMarginPct != null &&
    fc.forecastProfit != null &&
    f.estimatedRevenue != null &&
    fc.forecastMarginPct * 100 < f.targetMarginPct
  ) {
    const gapPct = f.targetMarginPct - fc.forecastMarginPct * 100;
    items.push({
      jobId: f.jobId,
      jobName: f.jobName,
      issueCode: "forecast_below_target",
      issue: `Forecast to finish at ${(fc.forecastMarginPct * 100).toFixed(1)}% margin, ${gapPct.toFixed(1)} points below your ${f.targetMarginPct}% target`,
      financialImpact: f.estimatedRevenue * (gapPct / 100),
      severity: fc.forecastMarginPct < 0 || gapPct > 10 ? "high" : gapPct > 5 ? "medium" : "low",
      confidence: fc.confidence ?? "low",
    });
  }

  // Work done but not billed yet. Cash the contractor has already spent and
  // hasn't asked for. Flagged past $1,000 and 5% of the contract, so
  // ordinary timing between draws doesn't raise it.
  if (f.status === "open" && f.wip && f.estimatedRevenue != null && !f.wip.costPastEstimate) {
    const under = -f.wip.overUnderBilling;
    if (under > 1000 && under > f.estimatedRevenue * 0.05) {
      items.push({
        jobId: f.jobId,
        jobName: f.jobName,
        issueCode: "underbilled",
        issue: `About ${Math.round(f.wip.percentComplete * 100)}% complete but billed ${Math.round((f.revenue / f.estimatedRevenue) * 100)}% of the contract`,
        financialImpact: under,
        severity: under > f.estimatedRevenue * 0.2 ? "high" : "medium",
        confidence: f.wip.percentCompleteSource === "manual" ? "high" : "medium",
      });
    }
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
        issue: "Margin has declined over the last several weekly briefs",
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
  /** 0-1. The progress figure the forecast divided by. */
  progress?: number;
  progressSource?: "manual" | "billing";
  /** One plain sentence saying exactly how this forecast was worked out. */
  method?: string;
}

/**
 * Forecast at completion for an open job.
 *
 * Cost to date divided by how far along the job is gives the cost the job
 * is on track to finish at. "How far along" is the contractor's own percent
 * complete when they have entered one, otherwise the share of the contract
 * billed so far (progress billing tracks the work on most jobs).
 *
 *   projected cost = cost to date / progress
 *   forecast cost  = the larger of projected cost, the estimated cost and
 *                    cost to date
 *   forecast profit = contract value - forecast cost
 *
 * The forecast never finishes a job under its estimate. Early costs are
 * lumpy (materials go on the card in week one, labor comes later), and a
 * forecast that promised an under-run on a job a third done would be the
 * most expensive kind of wrong. It only ever warns.
 *
 * The version this replaces was max(actual, estimate): it could not see an
 * overrun until the money had already been spent, and without an estimate
 * it divided by billed-to-date revenue and reported big losses on jobs that
 * were simply part-billed.
 */
export function computeForecastAtCompletion(job: JobInput, f: JobFinancials, now: Date): ForecastResult {
  if (job.status !== "open") {
    return {
      available: false,
      reason: "Forecast at completion only applies to jobs still in progress. This one is marked completed.",
    };
  }
  const contract = f.estimatedRevenue;
  if (contract == null || contract <= 0) {
    return {
      available: false,
      reason:
        "No contract value for this job. Add a QuickBooks estimate for it, or type the contract value in Job Details on this page.",
    };
  }
  if (f.costs <= 0) {
    return {
      available: false,
      reason: "No costs have been assigned to this job in QuickBooks yet, so there is nothing to project from.",
    };
  }

  let progress: number | null = null;
  let progressSource: "manual" | "billing" | null = null;
  if (job.percentCompleteOverride != null && job.percentCompleteOverride > 0) {
    progress = Math.min(1, job.percentCompleteOverride / 100);
    progressSource = "manual";
  } else if (f.revenue > 0) {
    progress = Math.min(1, f.revenue / contract);
    progressSource = "billing";
  }
  if (progress == null || progressSource == null) {
    return {
      available: false,
      reason:
        "Nothing has been billed on this job yet, so there is no measure of how far along it is. Enter a percent complete in Job Details and the forecast appears straight away.",
    };
  }
  if (progress < 0.05) {
    return {
      available: false,
      reason: `This job is only ${Math.round(progress * 100)}% along, too early for a forecast worth trusting.`,
    };
  }
  if (progressSource === "billing") {
    const daysSinceActivity = f.lastFinancialActivity
      ? (now.getTime() - f.lastFinancialActivity.getTime()) / 86_400_000
      : Infinity;
    if (daysSinceActivity > 30) {
      return {
        available: false,
        reason: `The last cost or invoice on this job was ${Number.isFinite(daysSinceActivity) ? Math.floor(daysSinceActivity) + " days ago" : "never recorded"}, so billing no longer says how far along it is. Enter a percent complete, or mark the job completed if it's finished.`,
      };
    }
  }

  const projected = f.costs / progress;
  const forecastCostAtCompletion = Math.max(projected, f.estimatedCost ?? 0, f.costs);
  const forecastProfit = contract - forecastCostAtCompletion;
  const forecastMarginPct = forecastProfit / contract;
  const confidence: "high" | "medium" | "low" =
    progressSource === "manual" ? (progress >= 0.25 ? "high" : "medium") : progress >= 0.5 ? "medium" : "low";

  const pct = Math.round(progress * 100);
  const method =
    progressSource === "manual"
      ? `Cost to date divided by your ${pct}% complete${f.estimatedCost != null ? ", and never less than the estimated cost" : ""}.`
      : `Cost to date divided by the ${pct}% of the contract billed so far${f.estimatedCost != null ? ", and never less than the estimated cost" : ""}. Entering a percent complete makes this more exact.`;

  return {
    available: true,
    actualCostToDate: f.costs,
    estimatedCost: f.estimatedCost ?? undefined,
    forecastCostAtCompletion,
    forecastProfit,
    forecastMarginPct,
    confidence,
    progress,
    progressSource,
    method,
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

  // An open job is bridged to its FORECAST, a completed job to what actually
  // happened. The two can't share steps, which is what this used to do: an
  // open job's steps were billed-and-spent-to-date against the whole-job
  // estimate, so a $20,000 job with $5,000 invoiced so far showed
  // "Revenue vs. estimate -$15,000" as a red loss, the running total went
  // negative, and the last bar then jumped to a forecast built from the
  // quote. Every bar was true and the chart as a whole was nonsense.
  if (f.status === "open") {
    // Without a forecast (none possible yet, or not on this plan) there is
    // no honest endpoint for a job that isn't finished. Showing to-date
    // figures against a whole-job estimate is the under-budget mistake again.
    if (!forecast.available || forecast.forecastProfit == null) return null;

    // The forecast keeps the quoted revenue and projects cost, so the only
    // movement from expected to forecast is projected cost. Overhead is not
    // a step here because the forecast doesn't include it.
    return [
      { label: "Expected profit", value: expectedProfit, isTotal: true },
      { label: "Projected cost vs. estimate", value: forecast.forecastProfit - expectedProfit, isTotal: false },
      { label: "Forecast profit", value: forecast.forecastProfit, isTotal: true },
    ];
  }

  const endValue = f.fullyLoadedProfit ?? f.grossProfit;
  // No end point we can stand behind means no bridge at all. This used to
  // fall back to the running total, which derived the endpoint from the
  // very variances the chart exists to explain, and on a job with revenue
  // and no tagged costs drew the whole invoice as profit.
  if (endValue == null) return null;

  const steps: ProfitLeakageStep[] = [
    { label: "Expected profit", value: expectedProfit, isTotal: true },
    { label: "Revenue vs. estimate", value: f.revenue - f.estimatedRevenue, isTotal: false },
    { label: "Cost vs. estimate", value: f.estimatedCost - f.costs, isTotal: false },
  ];
  if (f.fullyLoadedProfit != null && f.grossProfit != null) {
    steps.push({ label: "Overhead allocation", value: f.fullyLoadedProfit - f.grossProfit, isTotal: false });
  }
  steps.push({ label: "Actual profit", value: endValue, isTotal: true });
  return steps;
}

/** Data Health looks at open jobs and jobs with any activity in this window. */
export const DATA_HEALTH_WINDOW_DAYS = 365;
/** An open job this quiet is almost certainly finished and just not marked so. */
export const IDLE_JOB_DAYS = 90;

export interface DataHealthReport {
  /** Open jobs with no estimated cost. Finished jobs are not nagged about. */
  jobsMissingEstimates: { jobId: string; jobName: string }[];
  jobsMissingCosts: { jobId: string; jobName: string }[];
  staleJobs: { jobId: string; jobName: string; daysSinceActivity: number }[];
  completedJobsWithUnresolvedActivity: { jobId: string; jobName: string }[];
  /**
   * Every in-scope job whose profit can't be calculated yet, with the
   * reason. The list behind the Data Health headline count.
   */
  jobsWithoutEnoughData: { jobId: string; jobName: string; reason: string }[];
  /**
   * Open jobs with no financial activity for IDLE_JOB_DAYS or more (or none
   * ever, on a QuickBooks record at least that old). Almost always finished
   * work that was never marked complete; offered as a one-click fix.
   */
  idleOpenJobs: { jobId: string; jobName: string; daysSinceActivity: number | null }[];
  /**
   * Job-cost lines (Cost of Goods Sold accounts, or items bought) in the last
   * 12 months that aren't tagged to any customer. These are real gaps: a
   * cost that belongs to some job and isn't on one. null = not measured yet.
   */
  untaggedJobCostCount: number | null;
  untaggedJobCostAmount: number | null;
  /**
   * Overhead (rent, fuel, insurance, software...) not tagged to a customer,
   * last 12 months. Information only: overhead is supposed to be untagged,
   * so this is never counted as a problem.
   */
  untaggedOverheadCount: number | null;
  untaggedOverheadAmount: number | null;
  // Tagged to a real QuickBooks customer that doesn't match any synced job
  // (directly or via an unambiguous parent-customer match). Last 12 months.
  unresolvedExpenseCount: number | null;
  unresolvedExpenseAmount: number | null;
  // Informational: matched, but through the job's parent customer.
  costsMatchedViaParentCount: number | null;
  costsMatchedViaParentAmount: number | null;
  /**
   * Employee time entries in the last 12 months with no pay rate on the
   * employee, so their hours have no cost. Fixed in QuickBooks by setting
   * the employee's pay rate (cost rate).
   */
  timeEntriesWithoutPayRate: number | null;
  // When the sync-derived counters above were measured (the last full sync).
  countsAsOf: Date | null;
  possibleDuplicates: { jobName: string; amount: number; date: string; jobId: string }[];
  /**
   * Jobs with labor from timesheets AND labor from journal entries (a
   * payroll that posts to jobs). Usually the same wages counted twice.
   */
  jobsWithDoubleLabor: { jobId: string; jobName: string }[];
  overallConfidence: DataConfidence;
  // The raw counts behind overallConfidence, over in-scope jobs.
  totalJobs: number;
  jobsWithEnoughData: number;
  jobsMissingData: number;
}

/**
 * Whether a job belongs in company-level health checks and the weekly
 * brief: open, or with any financial activity in the window. A contractor's
 * QuickBooks can hold ten years of finished projects; grading the business
 * on them buried this year's real gaps under history nobody will fix.
 */
export function isInScope(j: Pick<JobFinancials, "status" | "lastFinancialActivity">, now: Date, days = DATA_HEALTH_WINDOW_DAYS): boolean {
  if (j.status === "open") return true;
  return j.lastFinancialActivity != null && now.getTime() - j.lastFinancialActivity.getTime() <= days * 86_400_000;
}

/**
 * Company-level rollup of data-quality issues, over in-scope jobs (see
 * isInScope). Sync-derived counts come from the last full sync and are null
 * ("not measured yet") rather than 0 until one has run.
 */
export function computeDataHealth(
  allJobs: JobFinancials[],
  now: Date,
  latestSyncEntitiesUpdated: Record<string, unknown> | null,
  countsAsOf: Date | null = null,
  scopeDays: number = DATA_HEALTH_WINDOW_DAYS
): DataHealthReport {
  const jobs = allJobs.filter((j) => isInScope(j, now, scopeDays));
  const daysSince = (d: Date | null) => (d ? Math.floor((now.getTime() - d.getTime()) / 86_400_000) : null);

  const jobsMissingEstimates = jobs
    .filter((j) => j.status === "open" && j.estimatedCost == null)
    .map((j) => ({ jobId: j.jobId, jobName: j.jobName }));

  const jobsMissingCosts = jobs
    .filter((j) => j.revenue > 0 && j.costs === 0)
    .map((j) => ({ jobId: j.jobId, jobName: j.jobName }));

  const staleJobs = jobs
    .filter((j) => j.status === "open" && j.flags.includes("stale_job"))
    .map((j) => ({ jobId: j.jobId, jobName: j.jobName, daysSinceActivity: daysSince(j.lastFinancialActivity) ?? Infinity }));

  const completedJobsWithUnresolvedActivity = jobs
    .filter((j) => j.status === "closed" && (j.flags.includes("revenue_no_costs") || j.flags.includes("costs_no_revenue")))
    .map((j) => ({ jobId: j.jobId, jobName: j.jobName }));

  const idleOpenJobs = allJobs
    .filter((j) => {
      if (j.status !== "open") return false;
      const last = j.lastFinancialActivity ?? j.qboCreatedAt;
      return last != null && now.getTime() - last.getTime() >= IDLE_JOB_DAYS * 86_400_000;
    })
    .map((j) => ({ jobId: j.jobId, jobName: j.jobName, daysSinceActivity: daysSince(j.lastFinancialActivity) }));

  const readCount = (key: string): number | null =>
    typeof latestSyncEntitiesUpdated?.[key] === "number" ? (latestSyncEntitiesUpdated[key] as number) : null;

  const jobsWithoutEnoughData = jobs
    .filter((j) => j.dataConfidence === "insufficient_data")
    .map((j) => ({ jobId: j.jobId, jobName: j.jobName, reason: j.unavailableReason ?? "Not enough revenue and cost data yet." }));

  const insufficientCount = jobsWithoutEnoughData.length;
  const totalJobs = jobs.length;
  const overallConfidence: DataConfidence =
    totalJobs === 0
      ? "insufficient_data"
      : insufficientCount / totalJobs > 0.5
      ? "low"
      : insufficientCount / totalJobs > 0.2
      ? "medium"
      : "high";

  return {
    jobsMissingEstimates,
    jobsMissingCosts,
    staleJobs,
    completedJobsWithUnresolvedActivity,
    jobsWithoutEnoughData,
    idleOpenJobs,
    untaggedJobCostCount: readCount("untaggedJobCostCount"),
    untaggedJobCostAmount: readCount("untaggedJobCostAmount"),
    untaggedOverheadCount: readCount("untaggedOverheadCount"),
    untaggedOverheadAmount: readCount("untaggedOverheadAmount"),
    unresolvedExpenseCount: readCount("unresolvedExpenseCount"),
    unresolvedExpenseAmount: readCount("unresolvedExpenseAmount"),
    costsMatchedViaParentCount: readCount("costsMatchedViaParentCount"),
    costsMatchedViaParentAmount: readCount("costsMatchedViaParentAmount"),
    timeEntriesWithoutPayRate: readCount("timeEntriesWithoutPayRate"),
    countsAsOf,
    // Filled in by the async wrapper, which has the raw cost rows.
    possibleDuplicates: [],
    jobsWithDoubleLabor: [],
    overallConfidence,
    totalJobs,
    jobsWithEnoughData: totalJobs - insufficientCount,
    jobsMissingData: insufficientCount,
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
        description: `Across ${catJobs.length} completed ${category} jobs with an estimate on file, actual costs averaged ${(avgOverrunPct * 100).toFixed(1)}% above estimate (avg $${Math.round(avgDollarImpact).toLocaleString()} over per job).`,
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
        description: `${belowTarget.length} of ${withMargin.length} completed ${category} jobs with an estimate on file came in below target margin.`,
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
        description: `${category[0].toUpperCase()}${category.slice(1)} jobs averaged ${(avgMargin * 100).toFixed(1)}% margin across ${withMargin.length} completed jobs with an estimate on file, against ${(overallAvg * 100).toFixed(1)}% for all your completed jobs with revenue and costs.`,
        financialImpact: null,
        confidence: withMargin.length >= 5 ? "high" : "medium",
        supportingJobIds: withMargin.map((j) => j.jobId),
      });
    }
  }

  return opportunities;
}

export type OpportunityGapCode =
  | "no_jobs"
  | "no_completed_jobs"
  | "too_few_completed_jobs"
  | "no_job_types"
  | "no_estimates_on_completed"
  | "job_types_spread_thin"
  | "no_pattern_found";

export interface OpportunityGap {
  code: OpportunityGapCode;
  /** The fact, stated plainly. */
  headline: string;
  /** The single next thing to do, or null when there is nothing to fix. */
  action: string | null;
  totalJobs: number;
  completedJobs: number;
  completedWithType: number;
  /** Completed jobs that have both a job type and an estimate, so a rule can see them. */
  eligibleJobs: number;
  /** Biggest number of eligible jobs sharing one job type. */
  largestTypeGroup: number;
}

const MIN_JOBS_PER_PATTERN = 3;

/**
 * Explains why Profit Opportunities is empty.
 *
 * "Not enough completed jobs yet to detect a pattern" was true and unhelpful.
 * It covered at least six different situations, and the one a new customer
 * most often hits - job type is a field only they can fill in, and it is
 * blank on every job - was invisible. Someone connects QuickBooks, syncs
 * cleanly, reads that sentence and concludes the product does not work,
 * when they are one form field away from it working.
 *
 * This mirrors the real gates in computeProfitOpportunities rather than
 * guessing at them, including the non-obvious one: a completed job with no
 * estimated cost never enters the grouping at all, so it cannot contribute
 * to the margin rules either.
 *
 * The last case matters most. Having enough data and finding no pattern is
 * a genuine, good result, and it must not be worded as a failure.
 */
export function diagnoseOpportunityGap(jobs: JobFinancials[]): OpportunityGap {
  const totalJobs = jobs.length;
  const completed = jobs.filter((j) => j.status === "closed" && j.profitabilityAvailable);
  const completedWithType = completed.filter((j) => j.category);
  const eligible = completedWithType.filter((j) => j.varianceVsEstimatePct != null);

  const groups: Record<string, number> = {};
  for (const j of eligible) groups[j.category as string] = (groups[j.category as string] ?? 0) + 1;
  const largestTypeGroup = Object.values(groups).reduce((max, n) => Math.max(max, n), 0);

  const base = {
    totalJobs,
    completedJobs: completed.length,
    completedWithType: completedWithType.length,
    eligibleJobs: eligible.length,
    largestTypeGroup,
  };

  if (totalJobs === 0) {
    return {
      ...base,
      code: "no_jobs",
      headline: "No jobs have synced from QuickBooks yet.",
      action: "Run a sync from the Profit Dashboard, then come back here.",
    };
  }

  if (completed.length === 0) {
    return {
      ...base,
      code: "no_completed_jobs",
      // Deliberately says "with revenue and costs recorded" rather than just
      // "completed": a closed job whose profitability couldn't be computed is
      // filtered out here too, and telling someone none of their jobs are
      // completed when several are would read as a bug.
      headline: `None of your ${totalJobs} ${totalJobs === 1 ? "job has" : "jobs have"} completed yet with both revenue and costs recorded.`,
      action:
        "Patterns come from finished work, where the final numbers are known. This fills in as jobs close.",
    };
  }

  if (completed.length < MIN_JOBS_PER_PATTERN) {
    return {
      ...base,
      code: "too_few_completed_jobs",
      headline: `You have ${completed.length} completed ${completed.length === 1 ? "job" : "jobs"} with both revenue and costs recorded. Patterns need at least ${MIN_JOBS_PER_PATTERN} in the same job type.`,
      action:
        "Nothing to fix. This is a comparison across finished jobs, so it needs a few of them before it can say anything honest.",
    };
  }

  if (completedWithType.length === 0) {
    return {
      ...base,
      code: "no_job_types",
      headline: `Your ${completed.length} completed jobs with revenue and costs recorded don't have a job type set.`,
      action:
        "Job type is the one field QuickBooks can't tell us, so it's set by hand. On the Jobs page, tick the jobs and use Set job type, or open a job and set it in Job Details. Once three completed jobs share a type, the comparison starts working.",
    };
  }

  if (eligible.length === 0) {
    return {
      ...base,
      code: "no_estimates_on_completed",
      headline: `${completedWithType.length} of your completed jobs have a job type, but none has an estimated cost.`,
      action:
        "Every pattern here compares actual cost against what the job was expected to cost, so an estimate is required. Add one in Job Details on the job's page.",
    };
  }

  if (largestTypeGroup < MIN_JOBS_PER_PATTERN) {
    const missingType = completed.length - completedWithType.length;
    return {
      ...base,
      code: "job_types_spread_thin",
      headline: `Your completed jobs are spread across job types, with at most ${largestTypeGroup} in any one. Patterns need ${MIN_JOBS_PER_PATTERN}.`,
      action:
        missingType > 0
          ? `${missingType} completed ${missingType === 1 ? "job has" : "jobs have"} no job type set. Filling those in is the quickest way to reach a group of three.`
          : "This fills in as more jobs of the same type finish.",
    };
  }

  return {
    ...base,
    code: "no_pattern_found",
    headline: `We compared ${eligible.length} completed jobs and found no pattern worth flagging.`,
    action:
      "That's a good result, not a missing feature. It means no job type is consistently running over estimate or missing its margin target.",
  };
}

export interface DashboardTotals {
  activeJobs: number;
  /**
   * How many jobs the customer is actually looking at: matching the
   * Active / Completed / All tab AND having revenue or costs inside the
   * selected period. Separate from activeJobs, which counts open jobs only
   * and is what the weekly digest wants.
   */
  jobsInView: number;
  revenue: number;
  trackedJobCosts: number;
  /** Null when no job in view has both revenue and costs. See the guard below. */
  jobGrossProfit: number | null;
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

  // Only jobs with money in the selected period. The date range windows each
  // job's cost entries and invoices but never removes the job itself, so a
  // job with nothing in the window sits in this list contributing zeroes.
  // Counting those made the job count the one tile that ignored the period
  // picker, which reads as the picker being broken.
  const jobsWithActivity = jobs.filter((j) => j.revenue > 0 || j.costs > 0);
  const jobsInView = jobsWithActivity.length;

  const revenue = jobs.reduce((s, j) => s + j.revenue, 0);
  const trackedJobCosts = jobs.reduce((s, j) => s + j.costs, 0);

  // Gross profit follows the same rule every single job follows: revenue
  // with no costs against it is not profit, it is an unanswered question.
  //
  // Without this, selecting a period that contains an invoice but none of
  // that job's costs produced revenue minus nothing and labelled it Job
  // Gross Profit. On 2026-09-17 "This month" read $9,000 revenue, $0 costs
  // and $9,000 profit, on a job that had spent $8,000. Average Job Margin
  // beside it correctly showed a dash, because it already filtered this way.
  //
  // Null rather than zero, so the UI shows a dash instead of asserting that
  // the period broke even.
  //
  // Revenue and Tracked Job Costs above stay as they are: they are plain
  // facts about the period. This one is a judgment, so it uses only the jobs
  // where the judgment can be made. That means it can differ from revenue
  // minus costs by whatever the incomplete jobs contribute, which is exactly
  // what the Data Health page exists to explain, and makes that page's
  // existing promise ("left out of your company totals rather than counted
  // as zero") true rather than aspirational.
  const profitableBasis = jobs.filter((j) => j.profitabilityAvailable);
  const jobGrossProfit = profitableBasis.length
    ? profitableBasis.reduce((sum, j) => sum + (j.revenue - j.costs), 0)
    : null;

  const withMargin = jobs.filter((j) => j.grossMarginPct != null);
  const avgJobMarginPct =
    withMargin.length > 0 ? withMargin.reduce((s, j) => s + j.grossMarginPct!, 0) / withMargin.length : null;

  // Both from the same Needs Attention items: completed jobs that finished
  // below target, and open jobs forecast to (Pro). Never an open job's margin
  // to date, which is billing timing rather than profit.
  const belowTargetItems = needsAttention.filter(
    (i) => i.issueCode === "below_target_margin" || i.issueCode === "forecast_below_target"
  );
  const jobsBelowTarget = new Set(belowTargetItems.map((i) => i.jobId)).size;
  const profitAtRisk = belowTargetItems.reduce((s, i) => s + (i.financialImpact ?? 0), 0);

  // Things that need fixing in the books. Missing estimates are setup, not
  // data problems, so they are listed on Data Health but not counted here;
  // untagged overhead is not a problem at all; parent-customer matches
  // succeeded.
  const dataIssues =
    dataHealth.jobsMissingCosts.length +
    dataHealth.staleJobs.length +
    dataHealth.completedJobsWithUnresolvedActivity.length +
    (dataHealth.untaggedJobCostCount ?? 0) +
    (dataHealth.unresolvedExpenseCount ?? 0) +
    (dataHealth.timeEntriesWithoutPayRate ?? 0) +
    dataHealth.possibleDuplicates.length +
    dataHealth.jobsWithDoubleLabor.length;

  return {
    activeJobs,
    jobsInView,
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

/** The contract value the engine uses: typed in JobProfitAI, else from QuickBooks estimates. */
const contractValueOf = (j: { manualContractValue?: Prisma.Decimal | null; estimatedRevenue: Prisma.Decimal | null }): number | null => {
  if (j.manualContractValue != null && Number(j.manualContractValue) > 0) return Number(j.manualContractValue);
  return j.estimatedRevenue == null ? null : Number(j.estimatedRevenue);
};

const percentOverrideOf = (j: { percentCompleteOverride?: Prisma.Decimal | null }): number | null =>
  j.percentCompleteOverride == null ? null : Number(j.percentCompleteOverride);

/**
 * An estimated cost of zero is no estimate. Data Health used to count it as
 * present while the forecast called it missing, and the job page printed
 * "Running $4,000 over the $0 estimate". Normalised once, here, so every
 * reader sees the same thing.
 */
const estimateOrNull = (d: Prisma.Decimal | null | undefined): number | null => {
  if (d == null) return null;
  const n = Number(d);
  return n > 0 ? n : null;
};

/**
 * Flags cost entries that share a job, amount, and calendar day but came from
 * *different* QBO source transactions (qboSourceId) - the upsert in the sync
 * route already prevents storing the same source transaction twice, so a hit
 * here means two distinct QBO transactions landed with identical numbers,
 * worth a human glance rather than an automatic merge (per spec: flag, don't
 * auto-merge).
 */
// Exported (was module-private) so Phase 8's Vitest suite can test the
// duplicate-detection logic directly - it's already a pure function (no
// Prisma calls of its own, just operates on already-fetched rows), it just
// hadn't needed an export yet since only getConnectionProfitData called it.
/**
 * Jobs carrying labor from both timesheets and journal entries. A payroll
 * service that posts wages to jobs by journal entry, plus timesheets costed
 * at pay rates, counts the same hours twice. Only open jobs and jobs with
 * activity in the last year are listed.
 */
export function findDoubleLabor(
  jobs: {
    id: string;
    name: string;
    costEntries: { qboSourceType: string; category: string; txnDate: Date }[];
  }[],
  now: Date = new Date()
): DataHealthReport["jobsWithDoubleLabor"] {
  const since = now.getTime() - DATA_HEALTH_WINDOW_DAYS * 86_400_000;
  const out: DataHealthReport["jobsWithDoubleLabor"] = [];
  for (const job of jobs) {
    let timesheet = false;
    let journal = false;
    for (const c of job.costEntries) {
      if (c.txnDate.getTime() < since || c.category !== "labor") continue;
      if (c.qboSourceType === "TimeActivity") timesheet = true;
      else if (c.qboSourceType === "JournalEntry") journal = true;
    }
    if (timesheet && journal) out.push({ jobId: job.id, jobName: job.name });
  }
  return out;
}

export function findPossibleDuplicateCostEntries(
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
  /** Same jobs as `jobs`, over their whole life (differs only when a period is selected). */
  lifetimeJobs: JobFinancials[];
  /** Forecasts for open jobs, when the plan includes forecasting. */
  forecasts: Map<string, ForecastResult>;
  /** Jobs on the selected Active/Completed/All tab, activity or not. */
  jobsInTab: number;
  needsAttention: NeedsAttentionItem[];
  dataHealth: DataHealthReport;
  opportunities: ProfitOpportunity[];
  totals: DashboardTotals;
  targetMarginPct: number | null;
}

export interface PriorMarginPoint {
  weekStarting: Date;
  marginPct: number; // fraction, e.g. 0.18
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
async function getPriorMarginsByJob(
  connectionId: string,
  limit = 6
): Promise<Record<string, PriorMarginPoint[]>> {
  // Newest first, then reversed into chronological order.
  //
  // This used to order ascending with the same take, which quietly means
  // "the first six digests this connection ever produced". A customer with a
  // year of history had a trend line frozen on their first six weeks, and
  // the margin-declining rule was reading data from last spring.
  const digests = await prisma.weeklyDigest.findMany({
    where: { connectionId },
    orderBy: { weekStarting: "desc" },
    take: limit,
  });
  digests.reverse();

  const byJob: Record<string, PriorMarginPoint[]> = {};
  for (const digest of digests) {
    const metrics = digest.metrics as unknown as { jobs?: { jobId: string; marginPct: number | null }[] };
    for (const j of metrics?.jobs ?? []) {
      if (j.marginPct == null) continue;
      (byJob[j.jobId] ??= []).push({ weekStarting: digest.weekStarting, marginPct: j.marginPct });
    }
  }
  return byJob;
}

/** The margins alone, for the rules that only care about the shape. */
const marginPctsOnly = (points: PriorMarginPoint[] | undefined): number[] | undefined =>
  points?.map((p) => p.marginPct);

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

  // Every job is loaded, and the Active/Completed/All tab is applied in
  // memory, because Data Health is not a per-tab report. It covers the whole
  // company on the page it links to, and part of it (untagged expenses, time
  // with no rate) is company-wide by nature. Filtering it by tab made the
  // dashboard card disagree with the Data Health page one click away, and on
  // the default Active tab "completed jobs with unresolved activity" could
  // only ever read zero.
  //
  // The tab uses effectiveJobStatus, never the raw `status` column, which
  // mirrors QuickBooks and ignores a job the contractor marked complete here.
  const allJobs = await prisma.job.findMany({
    where: { connectionId, ...VISIBLE_JOB_WHERE },
    include: { costEntries: true, invoices: true },
  });
  const jobs =
    statusFilter === "all" ? allJobs : allJobs.filter((j) => effectiveJobStatus(j) === statusFilter);

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

  const toJobInput = (j: (typeof jobs)[number], windowed: boolean): JobInput => ({
    id: j.id,
    name: j.name,
    customerName: j.customerName,
    status: effectiveJobStatus(j),
    category: j.category,
    estimatedRevenue: contractValueOf(j),
    estimatedCost: estimateOrNull(j.estimatedCost),
    percentCompleteOverride: percentOverrideOf(j),
    qboCreatedAt: j.qboCreatedAt,
    startDate: j.startDate,
    endDate: j.endDate,
    updatedAt: j.updatedAt,
    costEntries: j.costEntries
      .filter((c) => !windowed || inRange(c.txnDate))
      .map((c) => ({ category: c.category, amount: toNum(c.amount), txnDate: c.txnDate })),
    invoices: j.invoices
      .filter((i) => !windowed || inRange(i.txnDate))
      .map((i) => ({ amount: toNum(i.amount), status: i.status, txnDate: i.txnDate })),
  });

  // Two passes over the SAME rows - no second database query.
  //
  // The period picker is a lens on money: revenue, costs, margin, the charts.
  // It is not a lens on diagnosis. Data Health, Needs Your Attention and the
  // profit opportunities all ask lifetime questions ("is anything untagged",
  // "is this job running over", "has this one gone quiet"), and answering
  // them from a one-month slice invents problems that don't exist and hides
  // ones that do: filter to March and a job that finished in February has no
  // costs at all, so it reports as untagged, unprofitable and abandoned.
  //
  // So the windowed numbers drive the totals and the jobs list, and the
  // lifetime numbers drive everything that makes a claim about a job. When
  // no range is selected the two are the same object and nothing is computed
  // twice.
  const financials = jobs.map((j) =>
    computeJobFinancials(toJobInput(j, true), { ...ctx, costsAreWindowed: Boolean(dateRange) })
  );
  const lifetimeFinancials = dateRange
    ? jobs.map((j) => computeJobFinancials(toJobInput(j, false), ctx))
    : financials;
  // Data Health's own basis: every job, whole life, whatever the tab says.
  const companyLifetimeFinancials =
    statusFilter === "all" ? lifetimeFinancials : allJobs.map((j) => computeJobFinancials(toJobInput(j, false), ctx));

  // The last FULL sync, deliberately, not the last sync of any kind.
  //
  // These counters are whole-company tallies: how many expenses are tagged to
  // nobody, how many time entries carry no rate. An incremental sync only
  // looks at what QuickBooks says changed since last time, so its tallies are
  // a delta, not a state. Reading the newest sync of any kind meant that the
  // moment an incremental sync ran and found nothing, Data Health reported
  // zero unassigned expenses while $850 sat there untagged, and said so in
  // green. A page whose job is to tell a contractor where their data is
  // incomplete must never be the thing that is incomplete.
  //
  // A full sync's numbers can be up to FULL_SYNC_INTERVAL_DAYS old, which is
  // why countsAsOf is carried through and shown next to them. Stale and
  // labelled beats current-looking and wrong.
  const latestFullSync = await prisma.syncRun.findFirst({
    where: { connectionId, status: "success", mode: "full" },
    orderBy: { startedAt: "desc" },
  });

  const dataHealth = computeDataHealth(
    companyLifetimeFinancials,
    now,
    (latestFullSync?.entitiesUpdated as Record<string, unknown> | null) ?? null,
    latestFullSync?.finishedAt ?? latestFullSync?.startedAt ?? null
  );
  dataHealth.possibleDuplicates = findPossibleDuplicateCostEntries(allJobs);
  dataHealth.jobsWithDoubleLabor = findDoubleLabor(allJobs);

  // Company-wide, like Data Health: patterns across completed jobs don't
  // stop existing because the Active tab is selected.
  const opportunities = computeProfitOpportunities(companyLifetimeFinancials);

  // Needs Attention: per-job rule evaluation, with prior-margin trend data
  // and same-category peer costs (completed jobs only) threaded in.
  //
  // Comparing one job's costs against its peers is the "cross-job
  // benchmarking" the Pro plan is sold on, so it is gated here rather than at
  // each of the six pages that call this function. A page that forgot to pass
  // a flag would hand a $149 account a Pro finding and nobody would notice;
  // gating at the single place peer data is assembled makes that impossible.
  // Everything else in Needs Your Attention is per-job and stays on both
  // plans.
  const canBenchmark = Boolean(
    await requireFeature(connection.userId, "cross_job_benchmarking")
  );
  // Open jobs are judged on their forecast, which is a Pro feature. On the
  // $149 plan open jobs simply aren't graded against target until they finish.
  const canForecast = Boolean(await requireFeature(connection.userId, "forecast_at_completion"));
  const forecastByJob = new Map<string, ForecastResult>();
  if (canForecast) {
    for (const [i, j] of jobs.entries()) {
      const f = lifetimeFinancials[i];
      if (f.status !== "open") continue;
      forecastByJob.set(f.jobId, computeForecastAtCompletion(toJobInput(j, false), f, now));
    }
  }

  const priorMarginsByJob = await getPriorMarginsByJob(connectionId);
  const completedByCategory: Record<string, JobFinancials[]> = {};
  // Peers come from every completed job, not the tab. On the Active tab the
  // tab contains no completed jobs, so the peer comparison silently switched
  // itself off for the view customers use most.
  for (const f of companyLifetimeFinancials) {
    if (f.status === "closed" && f.category) (completedByCategory[f.category] ??= []).push(f);
  }
  const needsAttention = lifetimeFinancials.flatMap((f) => {
    const peerCompletedCostByCategory: Record<string, number[]> = {};
    if (canBenchmark && f.category && completedByCategory[f.category]) {
      for (const peer of completedByCategory[f.category]) {
        if (peer.jobId === f.jobId) continue;
        for (const [cat, amt] of Object.entries(peer.costByCategory)) {
          (peerCompletedCostByCategory[cat] ??= []).push(amt);
        }
      }
    }
    return computeNeedsAttentionForJob(f, {
      priorMarginPcts: marginPctsOnly(priorMarginsByJob[f.jobId]),
      peerCompletedCostByCategory,
      forecast: forecastByJob.get(f.jobId) ?? null,
    });
  });

  const totals = computeDashboardTotals(financials, needsAttention, dataHealth, ctx.targetMarginPct);

  return {
    connectionId,
    jobs: financials,
    jobsInTab: jobs.length,
    needsAttention,
    dataHealth,
    opportunities,
    totals,
    targetMarginPct: ctx.targetMarginPct,
    forecasts: forecastByJob,
    lifetimeJobs: lifetimeFinancials,
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
    where: { connectionId, ...CLOSED_JOB_WHERE },
    include: { costEntries: true, invoices: true },
  });

  // UTC, explicitly. Transaction dates arrive from QuickBooks as date-only
  // strings and are stored as midnight UTC, so reading them with the local
  // getMonth() bucketed them correctly on Vercel (UTC) and one month early in
  // any developer timezone west of it. Same reasoning as formatDate.
  const periodKey = (d: Date): string =>
    granularity === "monthly"
      ? `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`
      : `${d.getUTCFullYear()}-Q${Math.floor(d.getUTCMonth() / 3) + 1}`;

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
  /**
   * Oldest-first margin snapshots from past weekly digests, each carrying the
   * week it was taken. The dates are part of the data, not decoration: the
   * Profit Trend chart used to label them 1, 2, 3, Now, which draws a gap of
   * two months and a gap of one week as the same distance.
   */
  priorMarginPoints: PriorMarginPoint[];
  rawCostEntries: { id: string; category: string; description: string | null; amount: number; txnDate: Date; qboSourceType: string; accountName: string | null }[];
  rawInvoices: { id: string; amount: number; status: string; txnDate: Date; qboSourceType: string; taxAmount: number | null }[];
  /** The contractor's own status choice, or null when following QuickBooks. */
  statusOverride: string | null;
  /** Contract value typed in JobProfitAI (wins), and the one from QuickBooks estimates. */
  manualContractValue: number | null;
  syncedContractValue: number | null;
  percentCompleteOverride: number | null;
  /** What the sync read from the QuickBooks customer's Active flag. */
  syncedStatus: string;
  /** Same check as Data Health, for this job only. */
  possibleDuplicates: DataHealthReport["possibleDuplicates"];
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
    status: effectiveJobStatus(job),
    category: job.category,
    estimatedRevenue: contractValueOf(job),
    estimatedCost: estimateOrNull(job.estimatedCost),
    percentCompleteOverride: percentOverrideOf(job),
    qboCreatedAt: job.qboCreatedAt,
    startDate: job.startDate,
    endDate: job.endDate,
    updatedAt: job.updatedAt,
    costEntries: job.costEntries.map((c) => ({ category: c.category, amount: toNum(c.amount), txnDate: c.txnDate })),
    invoices: job.invoices.map((i) => ({ amount: toNum(i.amount), status: i.status, txnDate: i.txnDate })),
  };

  const financials = computeJobFinancials(jobInput, ctx);
  const forecast = computeForecastAtCompletion(jobInput, financials, now);
  // The bridge for an open job ends on the forecast, so it follows the same
  // plan gate as the forecast panel. Otherwise a plan without forecasting
  // saw "Forecast at Completion is part of Profit Intelligence" beside a
  // chart whose last bar was labelled "Forecast profit".
  const canForecast = Boolean(await requireFeature(connection.userId, "forecast_at_completion"));
  const leakage = computeProfitLeakage(
    financials,
    canForecast ? forecast : { available: false, reason: "Not on this plan." }
  );

  // Peer costs for the outlier rule: other completed jobs in the same
  // category, same connection. Gated on the Pro cross-job benchmarking
  // feature, same as the connection-level path above. Skipping it also skips
  // the peer query entirely, so a $149 account doesn't pay the database cost
  // of an analysis it isn't shown.
  const canBenchmark = Boolean(
    await requireFeature(connection.userId, "cross_job_benchmarking")
  );
  const peerCompletedCostByCategory: Record<string, number[]> = {};
  if (canBenchmark && job.category) {
    const peers = await prisma.job.findMany({
      where: { connectionId: connection.id, category: job.category, ...CLOSED_JOB_WHERE, id: { not: job.id } },
      include: { costEntries: true, invoices: true },
    });
    for (const peer of peers) {
      const peerInput: JobInput = {
        id: peer.id,
        name: peer.name,
        customerName: peer.customerName,
        status: effectiveJobStatus(peer),
        category: peer.category,
        estimatedRevenue: contractValueOf(peer),
        estimatedCost: estimateOrNull(peer.estimatedCost),
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
    priorMarginPcts: marginPctsOnly(priorMarginsByJob[job.id]),
    peerCompletedCostByCategory,
    forecast: canForecast ? forecast : null,
  });

  return {
    connectionId: connection.id,
    connectionUserId: connection.userId,
    companyName: connection.companyName,
    financials,
    forecast,
    leakage,
    needsAttention,
    priorMarginPoints: priorMarginsByJob[job.id] ?? [],
    rawCostEntries: job.costEntries.map((c) => ({
      id: c.id,
      category: c.category,
      description: c.description,
      amount: toNum(c.amount),
      txnDate: c.txnDate,
      qboSourceType: c.qboSourceType,
      accountName: c.accountName,
    })),
    rawInvoices: job.invoices.map((i) => ({
      id: i.id,
      amount: toNum(i.amount),
      status: i.status,
      txnDate: i.txnDate,
      qboSourceType: i.qboSourceType,
      taxAmount: i.taxAmount == null ? null : toNum(i.taxAmount),
    })),
    statusOverride: job.statusOverride,
    manualContractValue: job.manualContractValue == null ? null : Number(job.manualContractValue),
    syncedContractValue: job.estimatedRevenue == null ? null : Number(job.estimatedRevenue),
    percentCompleteOverride: percentOverrideOf(job),
    syncedStatus: job.status,
    possibleDuplicates: findPossibleDuplicateCostEntries([job]),
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
  /** Open jobs with a contract value: billed minus earned (see computeWip). */
  overUnderBilling?: number | null;
  percentComplete?: number | null;
  /** Pro only: forecast margin at completion for an open job. */
  forecastMarginPct?: number | null;
  flags: string[];
}

export interface ConnectionMetrics {
  connectionId: string;
  weekStarting: Date;
  /** Every job, so next week's comparison sees exactly what this week stored. */
  jobs: JobMetrics[];
  /**
   * The jobs the brief is about: open jobs, plus jobs with any activity in
   * the last BRIEF_RECENT_DAYS. A company's QuickBooks can hold years of
   * finished projects, and a brief that led with a 2021 job every Monday
   * was a brief nobody would read.
   */
  briefJobIds: string[];
  topConcerns: JobMetrics[];
  totals: {
    activeJobs: number;
    totalActualCost: number;
    totalActualRevenue: number;
    blendedMarginPct: number | null;
  };
  // Data Health over in-scope jobs (see isInScope), as the Data Health page shows it.
  dataHealth: DataHealthReport;
  /**
   * The same checks over just the brief's jobs. Its overallConfidence
   * decides whether the brief gets an AI narrative, and the notice sent
   * instead lists its jobs, so the reason given matches the reason used.
   */
  briefDataHealth: DataHealthReport;
}

export const BRIEF_RECENT_DAYS = 90;

export async function computeConnectionMetrics(connectionId: string, weekStarting: Date): Promise<ConnectionMetrics> {
  // `weekStarting` is a label (the Monday this digest is "for"), not "now" -
  // pass the real current time to the engine so staleness/date-based flags
  // are computed correctly regardless of which day of the week this runs on.
  const now = new Date();
  const data = await getConnectionProfitData(connectionId, now);

  const jobMetrics: JobMetrics[] = data.jobs.map((f) => {
    const forecast = data.forecasts.get(f.jobId);
    return {
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
      overUnderBilling: f.wip ? Math.round(f.wip.overUnderBilling) : null,
      percentComplete: f.wip ? f.wip.percentComplete : null,
      forecastMarginPct: forecast?.available ? forecast.forecastMarginPct ?? null : null,
      flags: f.flags,
    };
  });

  const inBrief = new Set(data.jobs.filter((f) => isInScope(f, now, BRIEF_RECENT_DAYS)).map((f) => f.jobId));
  const briefJobs = jobMetrics.filter((j) => inBrief.has(j.jobId));

  // Ranked by money, not by how many flags a job has. Every job without an
  // estimate carries a flag, so ranking by flag count put data gaps on old
  // jobs ahead of a live job running $10,000 over.
  const impact = (j: JobMetrics) =>
    Math.max(
      j.varianceVsEstimate != null && j.varianceVsEstimate > 0 ? j.varianceVsEstimate : 0,
      j.marginPct != null && j.marginPct < 0 ? j.actualCost - j.actualRevenue : 0,
      j.overUnderBilling != null && j.overUnderBilling < 0 ? -j.overUnderBilling : 0
    );
  const topConcerns = briefJobs
    .filter((j) => impact(j) > 0 || j.flags.some((f) => f !== "no_estimate_on_file"))
    .sort((a, b) => impact(b) - impact(a))
    .slice(0, 5);

  const activeJobs = jobMetrics.filter((j) => j.status === "open").length;
  const totalActualCost = briefJobs.reduce((s, j) => s + j.actualCost, 0);
  const totalActualRevenue = briefJobs.reduce((s, j) => s + j.actualRevenue, 0);
  // Margin only over jobs that have both revenue and costs, the same basis
  // as the dashboard's Job Gross Profit.
  const marginBasis = briefJobs.filter((j) => j.actualRevenue > 0 && j.actualCost > 0);
  const basisRevenue = marginBasis.reduce((s, j) => s + j.actualRevenue, 0);
  const basisCost = marginBasis.reduce((s, j) => s + j.actualCost, 0);
  const blendedMarginPct = basisRevenue > 0 ? (basisRevenue - basisCost) / basisRevenue : null;

  const briefDataHealth: DataHealthReport = {
    ...computeDataHealth(data.jobs, now, null, null, BRIEF_RECENT_DAYS),
    // Sync-level tallies are company-wide; carry them over unchanged.
    untaggedJobCostCount: data.dataHealth.untaggedJobCostCount,
    untaggedJobCostAmount: data.dataHealth.untaggedJobCostAmount,
    untaggedOverheadCount: data.dataHealth.untaggedOverheadCount,
    untaggedOverheadAmount: data.dataHealth.untaggedOverheadAmount,
    unresolvedExpenseCount: data.dataHealth.unresolvedExpenseCount,
    unresolvedExpenseAmount: data.dataHealth.unresolvedExpenseAmount,
    costsMatchedViaParentCount: data.dataHealth.costsMatchedViaParentCount,
    costsMatchedViaParentAmount: data.dataHealth.costsMatchedViaParentAmount,
    timeEntriesWithoutPayRate: data.dataHealth.timeEntriesWithoutPayRate,
    countsAsOf: data.dataHealth.countsAsOf,
    possibleDuplicates: data.dataHealth.possibleDuplicates.filter((d) => inBrief.has(d.jobId)),
  };

  return {
    connectionId,
    weekStarting,
    jobs: jobMetrics,
    briefJobIds: [...inBrief],
    topConcerns,
    totals: { activeJobs, totalActualCost, totalActualRevenue, blendedMarginPct },
    dataHealth: data.dataHealth,
    briefDataHealth,
  };
}
