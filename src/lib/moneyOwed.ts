import type { JobFinancials } from "./profitability";

/**
 * "Money you're owed": cash the contractor has earned and not collected,
 * in three kinds, kept apart because they mean different things.
 *
 *  - Unpaid invoices: billed, not yet paid (QuickBooks' open balance on
 *    each invoice, which includes any sales tax).
 *  - Work done, not billed: on an open job, the contract times percent
 *    complete, less what's been billed (the WIP figure). Money already
 *    spent on the job and not yet asked for.
 *  - Possible change orders: an open job whose costs have gone well past its
 *    cost estimate while its billing hasn't gone past the contract. If the
 *    extra was work outside the original scope, it's a change order nobody
 *    billed; if it wasn't, it's an overrun. Only the contractor knows which,
 *    so it's listed as "possible" and never added to the total.
 *
 * Pure. Open jobs with no cost or invoice for 90 days are left out of the
 * last two: they're almost always finished and never marked so.
 */

const DAY = 86_400_000;
const IDLE_DAYS = 90;

export interface OpenInvoiceRow {
  jobId: string;
  jobName: string;
  customerName: string | null;
  txnDate: Date;
  openBalance: number;
}

export interface UnpaidByJob {
  jobId: string;
  jobName: string;
  customerName: string | null;
  balance: number;
  invoices: number;
  /** Days since the oldest unpaid invoice was dated. */
  oldestDays: number;
  /** Balance by age since the invoice date: 0-30, 31-60, 61-90, over 90 days. */
  buckets: [number, number, number, number];
}

export interface UnbilledJob {
  jobId: string;
  jobName: string;
  amount: number;
  percentComplete: number;
  percentCompleteSource: "manual" | "cost";
  billed: number;
  contract: number;
}

export interface PossibleChangeOrder {
  jobId: string;
  jobName: string;
  overBy: number;
  estimatedCost: number;
  costs: number;
  billed: number;
  contract: number;
  /** What the extra would need to be billed at to keep the job's target margin, when it has one. */
  priceAtTarget: number | null;
}

export interface MoneyOwed {
  unpaid: { jobs: UnpaidByJob[]; total: number; invoices: number; over60: number };
  unbilled: { jobs: UnbilledJob[]; total: number };
  changeOrders: { jobs: PossibleChangeOrder[]; total: number };
  /** Unpaid invoices plus work done and not billed. Possible change orders aren't included. */
  total: number;
}

export function computeMoneyOwed(input: {
  now: Date;
  openInvoices: OpenInvoiceRow[];
  jobs: JobFinancials[];
  /** Jobs whose cost estimate was filled in from the target margin, which isn't a real estimate to be over. */
  targetFilledEstimates?: Set<string>;
}): MoneyOwed {
  const { now } = input;

  // Unpaid invoices, by job.
  const byJob = new Map<string, UnpaidByJob>();
  let over60 = 0;
  for (const inv of input.openInvoices) {
    if (!(inv.openBalance > 0)) continue;
    const age = Math.max(0, Math.floor((now.getTime() - inv.txnDate.getTime()) / DAY));
    const row =
      byJob.get(inv.jobId) ??
      { jobId: inv.jobId, jobName: inv.jobName, customerName: inv.customerName, balance: 0, invoices: 0, oldestDays: 0, buckets: [0, 0, 0, 0] as [number, number, number, number] };
    row.balance += inv.openBalance;
    row.invoices += 1;
    row.oldestDays = Math.max(row.oldestDays, age);
    const b = age <= 30 ? 0 : age <= 60 ? 1 : age <= 90 ? 2 : 3;
    row.buckets[b] += inv.openBalance;
    if (age > 60) over60 += inv.openBalance;
    byJob.set(inv.jobId, row);
  }
  const unpaidJobs = [...byJob.values()].sort((a, b) => b.oldestDays - a.oldestDays || b.balance - a.balance);
  const unpaidTotal = unpaidJobs.reduce((s, j) => s + j.balance, 0);

  const active = input.jobs.filter(
    (f) => f.status === "open" && f.lastFinancialActivity != null && now.getTime() - f.lastFinancialActivity.getTime() <= IDLE_DAYS * DAY
  );

  // Work done, not billed: the same rule as the feed and the WIP report.
  const unbilled: UnbilledJob[] = [];
  for (const f of active) {
    if (!f.wip || f.estimatedRevenue == null || f.wip.costPastEstimate) continue;
    const under = -f.wip.overUnderBilling;
    if (under > 1000 && under > f.estimatedRevenue * 0.05) {
      unbilled.push({
        jobId: f.jobId,
        jobName: f.jobName,
        amount: under,
        percentComplete: f.wip.percentComplete,
        percentCompleteSource: f.wip.percentCompleteSource,
        billed: f.revenue,
        contract: f.estimatedRevenue,
      });
    }
  }
  unbilled.sort((a, b) => b.amount - a.amount);

  // Costs well past the estimate, billing not past the contract.
  const changeOrders: PossibleChangeOrder[] = [];
  for (const f of active) {
    if (f.estimatedCost == null || f.estimatedCost <= 0 || f.estimatedRevenue == null) continue;
    if (input.targetFilledEstimates?.has(f.jobId)) continue;
    const overBy = f.costs - f.estimatedCost;
    if (overBy <= 0 || f.costs <= f.estimatedCost * 1.1 || overBy < 500) continue;
    if (f.revenue > f.estimatedRevenue) continue;
    const target = f.targetMarginPct != null && f.targetMarginPct > 0 && f.targetMarginPct < 90 ? f.targetMarginPct / 100 : null;
    changeOrders.push({
      jobId: f.jobId,
      jobName: f.jobName,
      overBy,
      estimatedCost: f.estimatedCost,
      costs: f.costs,
      billed: f.revenue,
      contract: f.estimatedRevenue,
      priceAtTarget: target != null ? overBy / (1 - target) : null,
    });
  }
  changeOrders.sort((a, b) => b.overBy - a.overBy);

  const unbilledTotal = unbilled.reduce((s, j) => s + j.amount, 0);
  return {
    unpaid: { jobs: unpaidJobs, total: unpaidTotal, invoices: unpaidJobs.reduce((s, j) => s + j.invoices, 0), over60 },
    unbilled: { jobs: unbilled, total: unbilledTotal },
    changeOrders: { jobs: changeOrders, total: changeOrders.reduce((s, j) => s + j.overBy, 0) },
    total: unpaidTotal + unbilledTotal,
  };
}
