import type { JobFinancials } from "./profitability";
import { buildWipSchedule, type NotScheduledNeed } from "./wipSchedule";

/**
 * "Money you're owed": cash the contractor has earned and not collected,
 * in three kinds, kept apart because they mean different things.
 *
 *  - Unpaid invoices: billed, not yet paid (QuickBooks' open balance on
 *    each invoice, which includes any sales tax). Customer payments not yet
 *    applied to an invoice, and unused credits, aren't read, so they aren't
 *    taken off.
 *  - Work done, not billed: the under billing on the WIP schedule (contract
 *    times percent complete, less what's been billed, before sales tax),
 *    built from the schedule itself so the two can't disagree. Only jobs
 *    under billed by more than $1,000 and 5% of the contract are listed, so
 *    ordinary timing between draws doesn't show; the rest is totalled
 *    separately (smallTotal) so the page can say how the figures tie.
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
/** Under billing smaller than both of these is timing between draws, not money to chase. */
const UNBILLED_MIN_AMOUNT = 1000;
const UNBILLED_MIN_SHARE = 0.05;

export interface OpenInvoiceRow {
  jobId: string;
  jobName: string;
  customerName: string | null;
  /** QuickBooks' invoice id. An invoice split across jobs by class has one row per job; this counts it once. */
  qboInvoiceId?: string | null;
  /** The invoice number people see, when the sync stores it. */
  docNumber?: string | null;
  txnDate: Date;
  /** When the sync stores QuickBooks' due date, invoices are aged from it. */
  dueDate?: Date | null;
  openBalance: number;
}

export interface UnpaidInvoice {
  qboInvoiceId: string | null;
  docNumber: string | null;
  txnDate: Date;
  dueDate: Date | null;
  openBalance: number;
  /** Days past the due date, or days since the invoice date (see MoneyOwed.unpaid.agedFrom). Never below 0. */
  ageDays: number;
  /** Aged from due dates and this one's due date hasn't come yet, so "0 days past due" would mislead. */
  notYetDue: boolean;
}

export interface UnpaidByJob {
  jobId: string;
  jobName: string;
  customerName: string | null;
  balance: number;
  invoices: number;
  /** Age of the oldest unpaid invoice, in days. */
  oldestDays: number;
  /** Balance by age: 0-30, 31-60, 61-90, over 90 days. */
  buckets: [number, number, number, number];
  /** Each unpaid invoice on the job, oldest first. */
  invoiceList: UnpaidInvoice[];
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
  unpaid: {
    jobs: UnpaidByJob[];
    /** Includes any sales tax: it's QuickBooks' open balance. */
    total: number;
    invoices: number;
    over60: number;
    /** "due_date" when every invoice has a due date stored; otherwise every invoice is aged from its invoice date. */
    agedFrom: "due_date" | "invoice_date";
  };
  unbilled: {
    jobs: UnbilledJob[];
    /** Before sales tax. */
    total: number;
    /** Under billing on the schedule too small to list. total + smallTotal is the WIP schedule's under billed total. */
    smallTotal: number;
    /** Open jobs whose billing could be judged: the jobs on the WIP schedule. */
    checked: number;
    /** Active open jobs whose billing couldn't be judged, by what they need. */
    notChecked: Record<NotScheduledNeed, number>;
  };
  changeOrders: { jobs: PossibleChangeOrder[]; total: number };
  /**
   * Unpaid invoices plus work done and not billed. Possible change orders
   * aren't included. The invoices include any sales tax and the unbilled
   * work doesn't, so the page labels the two parts.
   */
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

  // Unpaid invoices, by job. Aged from the due date only when every invoice
  // has one, so the buckets never mix two meanings.
  const open = input.openInvoices.filter((inv) => inv.openBalance > 0);
  const agedFrom: MoneyOwed["unpaid"]["agedFrom"] = open.length > 0 && open.every((inv) => inv.dueDate != null) ? "due_date" : "invoice_date";
  const byJob = new Map<string, UnpaidByJob>();
  const invoiceIds = new Set<string>();
  let unnamedInvoices = 0;
  let over60 = 0;
  for (const inv of open) {
    const from = agedFrom === "due_date" ? inv.dueDate! : inv.txnDate;
    const age = Math.max(0, Math.floor((now.getTime() - from.getTime()) / DAY));
    const row =
      byJob.get(inv.jobId) ??
      {
        jobId: inv.jobId,
        jobName: inv.jobName,
        customerName: inv.customerName,
        balance: 0,
        invoices: 0,
        oldestDays: 0,
        buckets: [0, 0, 0, 0] as [number, number, number, number],
        invoiceList: [],
      };
    row.balance += inv.openBalance;
    row.invoices += 1;
    row.oldestDays = Math.max(row.oldestDays, age);
    const b = age <= 30 ? 0 : age <= 60 ? 1 : age <= 90 ? 2 : 3;
    row.buckets[b] += inv.openBalance;
    row.invoiceList.push({
      qboInvoiceId: inv.qboInvoiceId ?? null,
      docNumber: inv.docNumber ?? null,
      txnDate: inv.txnDate,
      dueDate: inv.dueDate ?? null,
      openBalance: inv.openBalance,
      ageDays: age,
      notYetDue: agedFrom === "due_date" && from.getTime() > now.getTime(),
    });
    if (age > 60) over60 += inv.openBalance;
    if (inv.qboInvoiceId) invoiceIds.add(inv.qboInvoiceId);
    else unnamedInvoices++;
    byJob.set(inv.jobId, row);
  }
  for (const row of byJob.values()) row.invoiceList.sort((a, b) => b.ageDays - a.ageDays || b.openBalance - a.openBalance);
  const unpaidJobs = [...byJob.values()].sort((a, b) => b.oldestDays - a.oldestDays || b.balance - a.balance);
  const unpaidTotal = unpaidJobs.reduce((s, j) => s + j.balance, 0);

  // Work done, not billed: straight from the WIP schedule, so this page and
  // the report leave out the same jobs (idle, costs past the estimate,
  // nothing to measure progress by) and use the same figures.
  const schedule = buildWipSchedule(
    input.jobs.filter((f) => f.status === "open"),
    now,
    input.targetFilledEstimates
  );
  const unbilled: UnbilledJob[] = [];
  let smallTotal = 0;
  for (const r of schedule.inProgress) {
    const under = r.underBilled;
    if (!(under > 0)) continue;
    if (under > UNBILLED_MIN_AMOUNT && under > r.contract * UNBILLED_MIN_SHARE) {
      unbilled.push({
        jobId: r.jobId,
        jobName: r.jobName,
        amount: under,
        percentComplete: r.percentComplete,
        percentCompleteSource: r.percentFromEntry ? "manual" : "cost",
        billed: r.billedToDate,
        contract: r.contract,
      });
    } else {
      smallTotal += under;
    }
  }
  unbilled.sort((a, b) => b.amount - a.amount);
  const notChecked: Record<NotScheduledNeed, number> = { contract: 0, progress: 0, estimate_passed: 0 };
  for (const j of schedule.notScheduled) notChecked[j.needs]++;

  // Costs well past the estimate, billing not past the contract.
  const active = input.jobs.filter(
    (f) => f.status === "open" && f.lastFinancialActivity != null && now.getTime() - f.lastFinancialActivity.getTime() <= IDLE_DAYS * DAY
  );
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
    unpaid: { jobs: unpaidJobs, total: unpaidTotal, invoices: invoiceIds.size + unnamedInvoices, over60, agedFrom },
    unbilled: { jobs: unbilled, total: unbilledTotal, smallTotal, checked: schedule.inProgress.length, notChecked },
    changeOrders: { jobs: changeOrders, total: changeOrders.reduce((s, j) => s + j.overBy, 0) },
    total: unpaidTotal + unbilledTotal,
  };
}
