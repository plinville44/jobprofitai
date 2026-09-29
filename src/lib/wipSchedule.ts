import type { JobFinancials } from "./profitability";
import { MIN_ENTERED_PERCENT_TO_PROJECT } from "./forecastRules";

/**
 * The Work in Progress schedule in the layout banks and bonding companies
 * ask for: every contract in progress with its estimated gross profit,
 * percent complete, earned revenue and over or under billing, then the
 * contracts completed in the last 12 months.
 *
 * The WIP page, the bank-ready report and the CSV all build from this, so
 * they can't disagree. Pure: pass the whole-life job figures (lifetimeJobs),
 * not a windowed slice.
 *
 * Estimated total cost is the job's cost estimate. Where the contractor
 * entered a percent complete, it's the larger of the estimate and what that
 * percent implies (cost to date / percent complete), so a job 50% done that
 * has already spent its whole estimate is projected to cost twice that, not
 * shown with nothing left to spend. Below 25% complete the implied figure is
 * mostly timing (materials bought early) and isn't used, so the estimate is
 * the only guide to the total cost.
 *
 * Left off the schedule and out of every total, and listed with what each
 * needs instead:
 *  - A job whose cost to date has passed its estimate, with no percent
 *    complete entered. Cost-to-cost would read it as 100% complete and the
 *    whole contract as earned, so a job that ran over would show as finished,
 *    under billed and profitable.
 *  - A job entered as under 25% complete whose cost to date has reached its
 *    estimate. With nothing to project from, the estimated total cost would
 *    be cost to date: nothing left to spend and a healthy estimated gross
 *    profit beside a large loss to date.
 *  - A job entered as under 25% complete with no cost estimate. Its total
 *    cost can't be estimated, and one blank row would blank the totals.
 *  - An open job with no cost or invoice for 90 days. It's almost always
 *    finished and never marked so, and its under billing is years-old
 *    history, not money to collect.
 */

const DAY = 86_400_000;
/** Open jobs this quiet are almost always finished. */
export const WIP_IDLE_DAYS = 90;
const COMPLETED_WINDOW_DAYS = 365;
/** Billing past the contract by less than this is rounding, not a change order. */
const BILLED_PAST_CONTRACT_TOLERANCE = 1;

export type NotScheduledNeed = "contract" | "progress" | "estimate_passed";

/** What each job not on the schedule needs, in the words the page, report and CSV all use. */
export const NOT_SCHEDULED_NEED_TEXT: Record<NotScheduledNeed, string> = {
  contract: "needs a contract value",
  // Also a job entered as under 25% complete with no cost estimate: too
  // early to project the total cost from the percent.
  progress: "needs a cost estimate, or a percent complete of 25% or more",
  estimate_passed: "costs have passed the estimate: needs an updated cost estimate or percent complete",
};

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
  /**
   * Earned revenue less cost to date, less any provision for loss: on a job
   * expected to lose money, the whole expected loss.
   */
  grossProfitToDate: number;
  /**
   * On a job whose estimated total cost is above the contract, the part of
   * the expected loss not yet in earned revenue less cost. Standard contract
   * accounting books the whole loss as soon as it's known, not a share of it
   * as the work goes on. 0 on a job expected to make money.
   */
  provisionForLoss: number;
  /**
   * How far billing has gone past the contract (0 when it hasn't). The
   * schedule keeps the contract as it is, the more cautious figure for a
   * bank; the extra is usually a change order not yet recorded.
   */
  billedPastContract: number;
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
  provisionForLoss: number;
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
  /** Active open jobs missing a contract value, a way to measure progress, or whose costs have passed the estimate. */
  notScheduled: { jobId: string; jobName: string; needs: NotScheduledNeed }[];
  /**
   * Open jobs with a contract value and a way to measure progress, left off
   * the schedule because nothing has been posted to them for WIP_IDLE_DAYS.
   * Named so the owner can mark them completed; idle jobs with nothing to
   * measure aren't listed, the same as before (Data Health lists every one).
   */
  idle: { jobId: string; jobName: string }[];
}

type IdleInput = Pick<JobFinancials, "status" | "lastFinancialActivity" | "qboCreatedAt">;

/** The job's last cost or invoice, or, with none, when QuickBooks created it. */
const lastSeen = (f: IdleInput): Date | null => f.lastFinancialActivity ?? f.qboCreatedAt;

/**
 * An open job with no cost or invoice for WIP_IDLE_DAYS (or none ever, on a
 * QuickBooks record at least that old). A job with no dates at all isn't
 * called idle: it has nothing billed or spent to put into a total.
 */
export function isIdleOpenJob(f: IdleInput, now: Date): boolean {
  if (f.status !== "open") return false;
  const last = lastSeen(f);
  return last != null && now.getTime() - last.getTime() > WIP_IDLE_DAYS * DAY;
}

/**
 * What an open job needs before it can go on the WIP schedule, or null when
 * it can go on as it is. Idle jobs are dealt with separately (isIdleOpenJob).
 */
export function wipScheduleNeed(f: JobFinancials): NotScheduledNeed | null {
  if (f.estimatedRevenue == null || f.estimatedRevenue <= 0) return "contract";
  if (!f.wip) return "progress";
  if (f.wip.costPastEstimate) return "estimate_passed";
  // Under 25% complete, cost to date says more about timing than about the
  // total (materials bought early), so the cost estimate is all there is to
  // estimate the total cost from.
  if (f.wip.percentCompleteSource === "manual" && f.wip.percentComplete < MIN_ENTERED_PERCENT_TO_PROJECT) {
    if (f.estimatedCost == null || f.estimatedCost <= 0) return "progress";
    if (f.costs >= f.estimatedCost) return "estimate_passed";
  }
  return null;
}

/**
 * Whether a job's over or under billing belongs in a total: it's on the WIP
 * schedule. The brief and anything else that adds up WIP figures uses this,
 * so no total counts a job the schedule leaves out.
 */
export function wipCountsInTotals(f: JobFinancials, now: Date): boolean {
  return f.status === "open" && wipScheduleNeed(f) == null && !isIdleOpenJob(f, now);
}

const byName = (a: { jobName: string }, b: { jobName: string }) => a.jobName.localeCompare(b.jobName);

export function estimatedTotalCostOf(f: JobFinancials): number | null {
  if (!f.wip) return null;
  const estimate = f.estimatedCost != null && f.estimatedCost > 0 ? Math.max(f.estimatedCost, f.costs) : null;
  const implied =
    f.wip.percentCompleteSource === "manual" && f.wip.percentComplete >= MIN_ENTERED_PERCENT_TO_PROJECT
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
  const idle: WipSchedule["idle"] = [];
  const completed: CompletedContractRow[] = [];

  for (const f of jobs) {
    if (f.status === "open") {
      // Idle: off the schedule and out of its totals, the rule the "not on
      // the schedule" list already followed. Named when it had figures that
      // would otherwise have counted.
      if (isIdleOpenJob(f, now)) {
        if (f.wip) idle.push({ jobId: f.jobId, jobName: f.jobName });
        continue;
      }
      const need = wipScheduleNeed(f);
      if (need == null && f.wip && f.estimatedRevenue != null) {
        const contract = f.estimatedRevenue;
        const estimatedTotalCost = estimatedTotalCostOf(f);
        const estimatedGrossProfit = estimatedTotalCost == null ? null : contract - estimatedTotalCost;
        const earnedLessCost = f.wip.earnedRevenue - f.costs;
        const provisionForLoss =
          estimatedGrossProfit != null && estimatedGrossProfit < 0 ? Math.max(0, earnedLessCost - estimatedGrossProfit) : 0;
        const overUnder = f.wip.overUnderBilling;
        const pastContract = f.revenue - contract;
        inProgress.push({
          jobId: f.jobId,
          jobName: f.jobName,
          customerName: f.customerName,
          contract,
          estimatedTotalCost,
          estimatedGrossProfit,
          costToDate: f.costs,
          percentComplete: f.wip.percentComplete,
          percentFromEntry: f.wip.percentCompleteSource === "manual",
          costFromTarget: targetFilledEstimates.has(f.jobId) && f.estimatedCost != null,
          earnedRevenue: f.wip.earnedRevenue,
          billedToDate: f.revenue,
          overBilled: Math.max(0, overUnder),
          underBilled: Math.max(0, -overUnder),
          costToComplete: estimatedTotalCost == null ? null : Math.max(0, estimatedTotalCost - f.costs),
          grossProfitToDate: earnedLessCost - provisionForLoss,
          provisionForLoss,
          billedPastContract: pastContract > BILLED_PAST_CONTRACT_TOLERANCE ? pastContract : 0,
        });
      } else if (need != null && lastSeen(f) != null) {
        // A job with no cost, invoice or QuickBooks date at all isn't listed
        // as needing anything, as before: there's nothing on it yet.
        notScheduled.push({ jobId: f.jobId, jobName: f.jobName, needs: need });
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
  idle.sort(byName);
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
      provisionForLoss: sum((r) => r.provisionForLoss),
    },
    completed,
    completedTotals: { revenue, cost, grossProfit: revenue - cost, margin: revenue > 0 ? (revenue - cost) / revenue : null },
    notScheduled,
    idle,
  };
}
