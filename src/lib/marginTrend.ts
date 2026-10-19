import type { JobFinancials, MarginTrendPoint } from "./profitability";

/**
 * Margin by job type, month by month: are remodels getting more profitable
 * or less? Each finished job counts once, in the month of its last cost or
 * invoice (when it finished, near enough), at its whole-job margin. A month's
 * margin is revenue-weighted: (revenue - cost) / revenue across the jobs that
 * finished in it, so one small job can't swing it.
 *
 * Transactions aren't bucketed by month here on purpose. A job that buys
 * materials in March and invoices in May reads as a loss in March and pure
 * profit in May, which says nothing about how the work was priced.
 *
 * The change compares the last three months with the three before, and only
 * when each side has at least two finished jobs; below that it's one job's
 * story, not a trend.
 */

export const TREND_MONTHS = 6;
const MIN_JOBS_EACH_SIDE = 2;
/** A type needs this many finished jobs in the window to get a row. */
const MIN_JOBS_FOR_ROW = 3;

export interface TrendCell {
  month: string; // "2026-09"
  jobs: number;
  revenue: number;
  cost: number;
  /** 0-1, or null with no finished jobs that month. */
  margin: number | null;
}

export interface TypeTrend {
  /** Job type key, or null for the all-jobs row. */
  type: string | null;
  months: TrendCell[];
  jobs: number;
  margin: number | null;
  /** Last three months' margin minus the three before, in fraction points (0.05 = 5 points). */
  change: number | null;
  /** The job type's target margin, as a percent (20 for 20%), when every job in the row shares one. */
  targetPct: number | null;
}

export interface MarginTrend {
  months: string[];
  all: TypeTrend | null;
  byType: TypeTrend[];
}

const monthKey = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;

export function trendMonths(now: Date, count = TREND_MONTHS): string[] {
  const out: string[] = [];
  for (let i = count - 1; i >= 0; i--) out.push(monthKey(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1))));
  return out;
}

const marginOf = (revenue: number, cost: number) => (revenue > 0 ? (revenue - cost) / revenue : null);

/** A finished job the trend can count: completed, with revenue and costs, finished by `now`. */
const countsAsFinished = (f: JobFinancials, now: Date) =>
  f.status === "closed" &&
  f.revenue > 0 &&
  f.costs > 0 &&
  f.lastFinancialActivity != null &&
  f.lastFinancialActivity.getTime() <= now.getTime();

const quarterKey = (d: Date) => `${d.getUTCFullYear()}-Q${Math.floor(d.getUTCMonth() / 3) + 1}`;

/**
 * The Profit Dashboard's margin trend, over all of a company's history:
 * each finished job counted once, at its whole-job figures, in the month
 * (or quarter) of its last cost or invoice, by the same rule as the
 * Opportunities trend above. A period's margin is revenue-weighted across
 * the jobs that finished in it.
 *
 * It used to put each transaction in its own month, which contradicted the
 * dashboard's own label ("each job from start to finish") and the
 * Opportunities page: a job that bought materials in March and billed in May
 * drew a loss in March and near pure profit in May. Periods are UTC, as
 * QuickBooks dates are stored as UTC midnight. Pure.
 */
export function marginTrendByPeriod(
  jobs: JobFinancials[],
  granularity: "monthly" | "quarterly",
  now: Date
): MarginTrendPoint[] {
  const key = granularity === "monthly" ? monthKey : quarterKey;
  const buckets = new Map<string, { revenue: number; costs: number }>();
  for (const f of jobs) {
    if (!countsAsFinished(f, now)) continue;
    const k = key(f.lastFinancialActivity!);
    const b = buckets.get(k) ?? { revenue: 0, costs: 0 };
    b.revenue += f.revenue;
    b.costs += f.costs;
    buckets.set(k, b);
  }
  return [...buckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([period, b]) => {
      const revenue = Math.round(b.revenue * 100) / 100;
      const costs = Math.round(b.costs * 100) / 100;
      return { period, revenue, costs, marginPct: marginOf(revenue, costs) };
    });
}

function buildRow(type: string | null, jobs: JobFinancials[], months: string[]): TypeTrend {
  const cells = new Map(months.map((m) => [m, { month: m, jobs: 0, revenue: 0, cost: 0, margin: null as number | null }]));
  for (const f of jobs) {
    const cell = cells.get(monthKey(f.lastFinancialActivity!));
    if (!cell) continue;
    cell.jobs += 1;
    cell.revenue += f.revenue;
    cell.cost += f.costs;
  }
  const list = [...cells.values()].map((c) => ({ ...c, margin: marginOf(c.revenue, c.cost) }));
  const half = Math.floor(months.length / 2);
  const side = (cs: TrendCell[]) => cs.reduce((s, c) => ({ jobs: s.jobs + c.jobs, revenue: s.revenue + c.revenue, cost: s.cost + c.cost }), { jobs: 0, revenue: 0, cost: 0 });
  const prior = side(list.slice(0, half));
  const recent = side(list.slice(months.length - half));
  const priorMargin = marginOf(prior.revenue, prior.cost);
  const recentMargin = marginOf(recent.revenue, recent.cost);
  const change =
    prior.jobs >= MIN_JOBS_EACH_SIDE && recent.jobs >= MIN_JOBS_EACH_SIDE && priorMargin != null && recentMargin != null
      ? recentMargin - priorMargin
      : null;
  const total = side(list);
  const targets = new Set(jobs.map((f) => f.targetMarginPct));
  return {
    type,
    months: list,
    jobs: total.jobs,
    margin: marginOf(total.revenue, total.cost),
    change,
    targetPct: targets.size === 1 ? [...targets][0] : null,
  };
}

export function computeMarginTrend(jobs: JobFinancials[], now: Date, count = TREND_MONTHS): MarginTrend {
  const months = trendMonths(now, count);
  const inWindow = new Set(months);
  const finished = jobs.filter((f) => countsAsFinished(f, now) && inWindow.has(monthKey(f.lastFinancialActivity!)));
  const byType = new Map<string, JobFinancials[]>();
  for (const f of finished) if (f.category) byType.set(f.category, [...(byType.get(f.category) ?? []), f]);
  const rows = [...byType.entries()]
    .filter(([, list]) => list.length >= MIN_JOBS_FOR_ROW)
    .map(([type, list]) => buildRow(type, list, months))
    .sort((a, b) => b.jobs - a.jobs || (a.type ?? "").localeCompare(b.type ?? ""));
  return {
    months,
    all: finished.length >= MIN_JOBS_FOR_ROW ? buildRow(null, finished, months) : null,
    byType: rows,
  };
}
