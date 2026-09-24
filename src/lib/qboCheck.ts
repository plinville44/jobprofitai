/**
 * "Check against QuickBooks": a job's totals here beside QuickBooks' own
 * Profit and Loss for the same customer or project.
 *
 * The first thing a contractor does in a trial is compare one job with
 * QuickBooks. This makes that comparison part of the product, and explains
 * the differences that are expected rather than leaving them to look like
 * mistakes:
 *
 *   - Labor from timesheets. QuickBooks' Profit and Loss only has costs
 *     that were posted to an account; time entries costed at pay rates are
 *     not postings, so they are here and not there.
 *   - Costs tagged to the parent customer that were assigned to this job
 *     (it was that customer's only job). QuickBooks reports them under the
 *     parent customer.
 *
 * Pure: the numbers come in, the comparison goes out (tested in
 * src/lib/__tests__/qboCheck.test.ts).
 */

export interface PnlTotals {
  /** Income section total. */
  income: number;
  /** Cost of goods sold + expenses + other expenses. */
  costs: number;
}

const num = (v: unknown): number => {
  const n = typeof v === "string" ? parseFloat(v.replace(/,/g, "")) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : 0;
};

function summaryAmount(row: any): number {
  const cols = row?.Summary?.ColData;
  return Array.isArray(cols) && cols.length > 1 ? num(cols[cols.length - 1]?.value) : 0;
}

function summaryLabel(row: any): string {
  const cols = row?.Summary?.ColData;
  return Array.isArray(cols) && cols.length > 0 ? String(cols[0]?.value ?? "") : "";
}

/** Reads the Income and cost totals out of a ProfitAndLoss report response. Null if it has none. */
export function parseProfitAndLoss(report: any): PnlTotals | null {
  const rows: any[] = report?.Rows?.Row;
  if (!Array.isArray(rows)) return null;
  const noData = (report?.Header?.Option ?? []).some((o: any) => o?.Name === "NoReportData" && o?.Value === "true");
  if (noData) return { income: 0, costs: 0 };

  let income = 0;
  let costs = 0;
  for (const row of rows) {
    const group = String(row?.group ?? "");
    const label = summaryLabel(row).toLowerCase();
    if (group === "Income") income += summaryAmount(row);
    else if (
      group === "COGS" ||
      group === "CostOfGoodsSold" ||
      group === "Expenses" ||
      group === "OtherExpenses" ||
      (!group && label.startsWith("total cost of goods sold"))
    ) {
      costs += summaryAmount(row);
    }
  }
  return { income: round2(income), costs: round2(costs) };
}

export interface OurJobTotals {
  /** Revenue net of sales tax, credits and refunds taken off. */
  revenue: number;
  /** Costs from bills, checks, expenses, credits and journal entries tagged directly to this job. */
  postedCosts: number;
  /** Labor from time entries at pay rates. Not in QuickBooks' Profit and Loss. */
  timesheetLabor: number;
  /** Costs tagged to the parent customer and assigned to this job here. */
  parentCustomerCosts: number;
}

export interface CheckLine {
  label: string;
  ours: number;
  quickbooks: number;
  difference: number;
  matches: boolean;
}

export interface CheckResult {
  lines: CheckLine[];
  allMatch: boolean;
  /** Plain-language notes on differences that are expected. */
  notes: string[];
}

/** Within a dollar counts as matching (rounding across many lines). */
const TOLERANCE = 1;

export function compareWithQuickBooks(ours: OurJobTotals, qb: PnlTotals): CheckResult {
  const line = (label: string, a: number, b: number): CheckLine => {
    const difference = round2(a - b);
    return { label, ours: round2(a), quickbooks: round2(b), difference, matches: Math.abs(difference) < TOLERANCE };
  };
  const lines = [line("Revenue", ours.revenue, qb.income), line("Costs posted in QuickBooks", ours.postedCosts, qb.costs)];

  const notes: string[] = [];
  if (ours.timesheetLabor !== 0) {
    notes.push(
      `JobProfitAI also counts ${money(ours.timesheetLabor)} of labor from timesheets at each person's pay rate. QuickBooks' Profit and Loss doesn't include time entries, so that amount is on top of the costs compared above.`
    );
  }
  if (ours.parentCustomerCosts !== 0) {
    notes.push(
      `${money(ours.parentCustomerCosts)} of costs were tagged in QuickBooks to the parent customer rather than this project. Because it's that customer's only job, JobProfitAI counts them here; QuickBooks reports them under the customer. They are left out of the comparison above.`
    );
  }
  if (!lines.every((l) => l.matches)) {
    notes.push(
      "Anything changed in QuickBooks since the last sync shows up here after the next one. Other common causes: an invoice made out to the parent customer instead of this project (counted here when it's that customer's only job), a transaction dated after today (QuickBooks' report stops at today), or a cost posted to a balance sheet account such as inventory, which the Profit and Loss leaves out."
    );
  }
  return { lines, allMatch: lines.every((l) => l.matches), notes };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function money(n: number): string {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD" });
}
