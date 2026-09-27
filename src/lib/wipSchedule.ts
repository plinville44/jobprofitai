import type { JobFinancials } from "./profitability";

/**
 * The Work in Progress schedule in the layout banks and bonding companies
 * ask for: every contract in progress with its estimated gross profit,
 * percent complete, earned revenue and over or under billing, then the
 * contracts completed in the last 12 months.
 *
 * Built from the same figures as the WIP page (computeWip), so the two can't
 * disagree. Pure: pass the whole-life job figures (lifetimeJobs), not a
 * windowed slice.
 *
 * Estimated total cost is the job's cost estimate, or cost to date where
 * cost has already passed the estimate (the job then reads 100% complete,
 * which is what cost-to-cost gives). Where the contractor entered a percent
 * complete, it's the larger of the estimate and what that percent implies
 * (cost to date / percent complete), so a job 50% done that has already
 * spent its whole estimate is projected to cost twice that, not shown with
 * nothing left to spend. Below 5% complete the implied figure is noise and
 * isn't used; with no estimate either, it's left blank rather than guessed.
 */

const DAY = 86_400_000;
/** Open jobs this quiet are almost always finished; the "not on the schedule" list leaves them out. */
const IDLE_DAYS = 90;
const COMPLETED_WINDOW_DAYS = 365;
const MIN_PERCENT_FOR_IMPLIED_COST = 0.05;

export interface WipScheduleRow {
  jobId: string;
  jobName: string;
  customerName: string | null;
  contract: number;
  estimatedTotalCost: number | null;
  estimatedGrossProfit: number | null;
  costToDate: number;
  /** 0-1. */
  percentComplete: number;
  /** True when percent complete is the contractor's own figure rather than cost to date / estimated cost. */
  percentFromEntry: boolean;
  /** True when the cost estimate was filled in from the target margin, not a real estimate. */
  costFromTarget: boolean;
  earnedRevenue: number;
  billedToDate: number;
  overBilled: number;
  underBilled: number;
  costToComplete: number | null;
  grossProfitToDate: number;
}

export interface WipScheduleTotals {
  contract: number;
  /** Null when any row's estimated total cost is unknown, so a total never quietly leaves jobs out. */
  estimatedTotalCost: number | null;
  estimatedGrossProfit: number | null;
  costToDate: number;
  earnedRevenue: number;
  billedToDate: number;
  overBilled: number;
  underBilled: number;
  costToComplete: number | null;
  grossProfitToDate: number;
}

export interface CompletedContractRow {
  jobId: string;
  jobName: string;
  customerName: string | null;
  revenue: number;
  cost: number;
  grossProfit: number;
  /** 0-1, or null with no revenue. */
  margin: number | null;
}

export interface WipSchedule {
  inProgress: WipScheduleRow[];
  totals: WipScheduleTotals;
  completed: CompletedContractRow[];
  completedTotals: { revenue: number; cost: number; grossProfit: number; margin: number | null };
  /** Active open jobs missing a contract value, or a way to measure progress. */
  notScheduled: { jobId: string; jobName: string; needs: "contract" | "progress" }[];
}

const byName = (a: { jobName: string }, b: { jobName: string }) => a.jobName.localeCompare(b.jobName);

export function estimatedTotalCostOf(f: JobFinancials): number | null {
  if (!f.wip) return null;
  const estimate = f.estimatedCost != null && f.estimatedCost > 0 ? Math.max(f.estimatedCost, f.costs) : null;
  const implied =
    f.wip.percentCompleteSource === "manual" && f.wip.percentComplete >= MIN_PERCENT_FOR_IMPLIED_COST
      ? f.costs / f.wip.percentComplete
      : null;
  if (estimate != null && implied != null) return Math.max(estimate, implied);
  return estimate ?? implied;
}

export function buildWipSchedule(
  jobs: JobFinancials[],
  now: Date,
  /** Jobs whose cost estimate was filled in from the target margin. */
  targetFilledEstimates: Set<string> = new Set()
): WipSchedule {
  const inProgress: WipScheduleRow[] = [];
  const notScheduled: WipSchedule["notScheduled"] = [];
  const completed: CompletedContractRow[] = [];

  for (const f of jobs) {
    if (f.status === "open") {
      if (f.wip && f.estimatedRevenue != null && f.estimatedRevenue > 0) {
        const estimatedTotalCost = estimatedTotalCostOf(f);
        const overUnder = f.wip.overUnderBilling;
        inProgress.push({
          jobId: f.jobId,
          jobName: f.jobName,
          customerName: f.customerName,
          contract: f.estimatedRevenue,
          estimatedTotalCost,
          estimatedGrossProfit: estimatedTotalCost == null ? null : f.estimatedRevenue - estimatedTotalCost,
          costToDate: f.costs,
          percentComplete: f.wip.percentComplete,
          percentFromEntry: f.wip.percentCompleteSource === "manual",
          costFromTarget: targetFilledEstimates.has(f.jobId) && f.estimatedCost != null,
          earnedRevenue: f.wip.earnedRevenue,
          billedToDate: f.revenue,
          overBilled: Math.max(0, overUnder),
          underBilled: Math.max(0, -overUnder),
          costToComplete: estimatedTotalCost == null ? null : Math.max(0, estimatedTotalCost - f.costs),
          grossProfitToDate: f.wip.earnedRevenue - f.costs,
        });
      } else {
        const last = f.lastFinancialActivity ?? f.qboCreatedAt;
        const active = last != null && now.getTime() - last.getTime() <= IDLE_DAYS * DAY;
        if (active) {
          notScheduled.push({
            jobId: f.jobId,
            jobName: f.jobName,
            needs: f.estimatedRevenue == null || f.estimatedRevenue <= 0 ? "contract" : "progress",
          });
        }
      }
      continue;
    }
    // Completed in the last 12 months, by its last cost or invoice.
    const last = f.lastFinancialActivity;
    if (last == null || now.getTime() - last.getTime() > COMPLETED_WINDOW_DAYS * DAY) continue;
    if (!(f.revenue > 0) || !(f.costs > 0)) continue;
    const grossProfit = f.revenue - f.costs;
    completed.push({
      jobId: f.jobId,
      jobName: f.jobName,
      customerName: f.customerName,
      revenue: f.revenue,
      cost: f.costs,
      grossProfit,
      margin: grossProfit / f.revenue,
    });
  }

  inProgress.sort(byName);
  notScheduled.sort(byName);
  completed.sort(byName);

  const sum = (pick: (r: WipScheduleRow) => number) => inProgress.reduce((s, r) => s + pick(r), 0);
  const sumKnown = (pick: (r: WipScheduleRow) => number | null) =>
    inProgress.some((r) => pick(r) == null) ? null : inProgress.reduce((s, r) => s + (pick(r) ?? 0), 0);

  const revenue = completed.reduce((s, r) => s + r.revenue, 0);
  const cost = completed.reduce((s, r) => s + r.cost, 0);

  return {
    inProgress,
    totals: {
      contract: sum((r) => r.contract),
      estimatedTotalCost: sumKnown((r) => r.estimatedTotalCost),
      estimatedGrossProfit: sumKnown((r) => r.estimatedGrossProfit),
      costToDate: sum((r) => r.costToDate),
      earnedRevenue: sum((r) => r.earnedRevenue),
      billedToDate: sum((r) => r.billedToDate),
      overBilled: sum((r) => r.overBilled),
      underBilled: sum((r) => r.underBilled),
      costToComplete: sumKnown((r) => r.costToComplete),
      grossProfitToDate: sum((r) => r.grossProfitToDate),
    },
    completed,
    completedTotals: { revenue, cost, grossProfit: revenue - cost, margin: revenue > 0 ? (revenue - cost) / revenue : null },
    notScheduled,
  };
}
