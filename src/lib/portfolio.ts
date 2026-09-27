import type { QuickBooksConnection } from "@prisma/client";
import { prisma } from "./prisma";
import { OPEN_JOB_WHERE, VISIBLE_JOB_WHERE } from "./jobStatus";
import { laborBurdenOf } from "./profitability";

/**
 * The portfolio: one row per QuickBooks company on the account, for a
 * bookkeeper (or an owner with several companies) to see at a glance which
 * clients need attention.
 *
 * Deliberately built from a handful of totals per company rather than the
 * full job-by-job calculation the dashboard runs, so a firm with thirty
 * clients gets the page in seconds. The margin is therefore the last 12
 * months by transaction date (revenue and costs dated in that window, labor
 * burden included), not the job-by-job margin on each company's dashboard;
 * the page says so.
 */

const DAY = 86_400_000;
export const PORTFOLIO_WINDOW_DAYS = 365;

export interface PortfolioRow {
  connectionId: string;
  companyName: string;
  lastSyncedAt: Date | null;
  syncError: string | null;
  openJobs: number;
  revenue: number;
  cost: number;
  /** 0-1, null with no revenue. */
  margin: number | null;
  /** Percent, e.g. 20. */
  targetPct: number | null;
  belowTarget: boolean;
  unpaid: number;
  unpaidOver60: number;
  /** Job costs in the last 12 months on no job, from the last full sync; null before one has run. */
  untaggedJobCost: number | null;
  /** Reasons to look at this client first, in plain words. */
  flags: string[];
}

export interface PortfolioTotals {
  revenue: number;
  cost: number;
  margin: number | null;
  unpaid: number;
  unpaidOver60: number;
  openJobs: number;
}

/** One company's row from its totals. Pure, for tests. */
export function portfolioRow(input: {
  connectionId: string;
  companyName: string;
  lastSyncedAt: Date | null;
  syncError: string | null;
  openJobs: number;
  revenue: number;
  /** Costs other than time-entry labor. */
  otherCost: number;
  /** Time-entry labor at pay rates, before burden. */
  timeLabor: number;
  laborBurden: number;
  targetPct: number | null;
  unpaid: number;
  unpaidOver60: number;
  untaggedJobCost: number | null;
  now: Date;
}): PortfolioRow {
  const cost = input.otherCost + input.timeLabor * (1 + input.laborBurden);
  const margin = input.revenue > 0 ? (input.revenue - cost) / input.revenue : null;
  const belowTarget = input.targetPct != null && margin != null && margin * 100 < input.targetPct;
  const flags: string[] = [];
  if (input.syncError) flags.push("QuickBooks connection needs attention");
  else if (!input.lastSyncedAt) flags.push("Not synced yet");
  else if (input.now.getTime() - input.lastSyncedAt.getTime() > 3 * DAY) flags.push("Not synced in over 3 days");
  if (belowTarget) flags.push("Margin below target");
  if (input.unpaidOver60 >= 1) flags.push("Invoices unpaid over 60 days");
  if (input.untaggedJobCost != null && input.untaggedJobCost >= 1 && input.revenue > 0 && input.untaggedJobCost > input.revenue * 0.02) {
    flags.push("Job costs not on any job");
  }
  return {
    connectionId: input.connectionId,
    companyName: input.companyName,
    lastSyncedAt: input.lastSyncedAt,
    syncError: input.syncError,
    openJobs: input.openJobs,
    revenue: input.revenue,
    cost,
    margin,
    targetPct: input.targetPct,
    belowTarget,
    unpaid: input.unpaid,
    unpaidOver60: input.unpaidOver60,
    untaggedJobCost: input.untaggedJobCost,
    flags,
  };
}

/** Clients needing the most attention first, then by name. */
export function sortPortfolio(rows: PortfolioRow[]): PortfolioRow[] {
  return [...rows].sort((a, b) => b.flags.length - a.flags.length || a.companyName.localeCompare(b.companyName));
}

export function portfolioTotals(rows: PortfolioRow[]): PortfolioTotals {
  const revenue = rows.reduce((s, r) => s + r.revenue, 0);
  const cost = rows.reduce((s, r) => s + r.cost, 0);
  return {
    revenue,
    cost,
    margin: revenue > 0 ? (revenue - cost) / revenue : null,
    unpaid: rows.reduce((s, r) => s + r.unpaid, 0),
    unpaidOver60: rows.reduce((s, r) => s + r.unpaidOver60, 0),
    openJobs: rows.reduce((s, r) => s + r.openJobs, 0),
  };
}

const num = (v: unknown) => (v == null ? 0 : Number(v));

async function rowFor(c: QuickBooksConnection, now: Date): Promise<PortfolioRow> {
  const since = new Date(now.getTime() - PORTFOLIO_WINDOW_DAYS * DAY);
  const over60 = new Date(now.getTime() - 60 * DAY);
  const onJob = { connectionId: c.id, ...VISIBLE_JOB_WHERE };
  const [openJobs, revenue, timeLabor, otherCost, unpaid, unpaidOld, fullSync] = await Promise.all([
    prisma.job.count({ where: { connectionId: c.id, ...VISIBLE_JOB_WHERE, ...OPEN_JOB_WHERE } }),
    prisma.invoiceSummary.aggregate({ where: { job: onJob, txnDate: { gte: since } }, _sum: { amount: true } }),
    prisma.costEntry.aggregate({ where: { job: onJob, txnDate: { gte: since }, qboSourceType: "TimeActivity" }, _sum: { amount: true } }),
    prisma.costEntry.aggregate({ where: { job: onJob, txnDate: { gte: since }, qboSourceType: { not: "TimeActivity" } }, _sum: { amount: true } }),
    prisma.invoiceSummary.aggregate({ where: { job: onJob, status: "open", openBalance: { gt: 0 } }, _sum: { openBalance: true } }),
    prisma.invoiceSummary.aggregate({
      where: { job: onJob, status: "open", openBalance: { gt: 0 }, txnDate: { lt: over60 } },
      _sum: { openBalance: true },
    }),
    prisma.syncRun.findFirst({
      where: { connectionId: c.id, status: "success", mode: "full" },
      orderBy: { startedAt: "desc" },
      select: { entitiesUpdated: true },
    }),
  ]);
  const counts = (fullSync?.entitiesUpdated ?? null) as Record<string, unknown> | null;
  const untagged = counts && typeof counts.untaggedJobCostAmount === "number" ? counts.untaggedJobCostAmount : null;
  return portfolioRow({
    connectionId: c.id,
    companyName: c.companyName ?? "Unnamed company",
    lastSyncedAt: c.lastSyncedAt,
    syncError: c.lastSyncStatus === "error" ? c.lastSyncError ?? "Sync failed" : null,
    openJobs,
    revenue: num(revenue._sum.amount),
    otherCost: num(otherCost._sum.amount),
    timeLabor: num(timeLabor._sum.amount),
    laborBurden: laborBurdenOf(c),
    targetPct: c.targetMarginPct == null ? null : Number(c.targetMarginPct),
    unpaid: num(unpaid._sum.openBalance),
    unpaidOver60: num(unpaidOld._sum.openBalance),
    untaggedJobCost: untagged,
    now,
  });
}

/** Rows for every company given, a few at a time so a large firm doesn't open dozens of queries at once. */
export async function getPortfolio(companies: QuickBooksConnection[], now = new Date()): Promise<PortfolioRow[]> {
  const rows: PortfolioRow[] = [];
  for (let i = 0; i < companies.length; i += 5) {
    rows.push(...(await Promise.all(companies.slice(i, i + 5).map((c) => rowFor(c, now)))));
  }
  return sortPortfolio(rows);
}
