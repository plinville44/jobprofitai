import { readFileSync } from "fs";
import { join } from "path";
import { describe, it, expect, vi, beforeEach } from "vitest";

// Fixes from the 2026-10-19 audit: the figures a contractor and their bank
// read off the dashboard, the feed, the brief and the WIP report.
//
// A small stand-in for the tables getConnectionProfitData and
// getMarginTrend read, so the async paths run as the pages run them.
const db: { connection: Record<string, any>; jobs: Record<string, any>[] } = { connection: {}, jobs: [] };

const matches = (row: Record<string, any>, cond: Record<string, any>) =>
  Object.entries(cond).every(([k, v]) => (row[k] ?? null) === v);

vi.mock("../prisma", () => ({
  prisma: {
    quickBooksConnection: {
      findUniqueOrThrow: async () => ({ ...db.connection, marginTargets: [] }),
      findUnique: async () => ({ ...db.connection }),
    },
    job: {
      findMany: async ({ where }: any) => {
        let rows = db.jobs.filter((j) => j.connectionId === where.connectionId && (j.missingSince ?? null) === null);
        if (where.OR) rows = rows.filter((j) => where.OR.some((c: Record<string, any>) => matches(j, c)));
        return rows.map((j) => ({ ...j, costEntries: [...j.costEntries], invoices: [...j.invoices] }));
      },
    },
    syncRun: { findFirst: async () => null },
    weeklyDigest: { findMany: async () => [] },
  },
}));
// Every plan feature on, so forecasts are made.
vi.mock("../entitlements", () => ({ requireFeature: async () => ({}) }));

import {
  computeConnectionMetrics,
  computeDashboardTotals,
  computeDataHealth,
  computeForecastAtCompletion,
  computeJobFinancials,
  computeNeedsAttentionForJob,
  findDoubleLabor,
  getConnectionProfitData,
  getMarginTrend,
  toCents,
  type FinancialContext,
  type JobFinancials,
  type JobInput,
} from "../profitability";
import { forecastIsActionable } from "../forecastRules";
import { marginTrendByPeriod } from "../marginTrend";
import { buildWipSchedule, wipCountsInTotals, wipReportBasis, wipReportDay } from "../wipSchedule";
import { computeOpportunityFeed } from "../opportunities";
import { computeMoneyOwed } from "../moneyOwed";
import { formatDateTime, formatPct } from "../format";

const NOW = new Date("2026-10-19T15:00:00Z");
const DAY = 86_400_000;
const daysAgo = (d: number, from: Date = NOW) => new Date(from.getTime() - d * DAY);
const read = (rel: string) => readFileSync(join(__dirname, "..", "..", rel), "utf8");

const ctx = (over: Partial<FinancialContext> = {}): FinancialContext => ({
  now: NOW,
  targetMarginPct: null,
  categoryTargetMarginPct: {},
  overheadEnabled: false,
  overheadMethod: null,
  overheadValue: null,
  lastSyncedAt: daysAgo(1),
  ...over,
});

function input(p: {
  id: string;
  status?: string;
  invoices?: number[];
  costs?: number[];
  contract?: number | null;
  estimate?: number | null;
  percent?: number | null;
  lastDaysAgo?: number;
  category?: string;
}): JobInput {
  const when = daysAgo(p.lastDaysAgo ?? 5);
  return {
    id: p.id,
    name: p.id,
    customerName: null,
    status: p.status ?? "open",
    category: p.category ?? "materials",
    estimatedRevenue: p.contract ?? null,
    estimatedCost: p.estimate ?? null,
    percentCompleteOverride: p.percent ?? null,
    qboCreatedAt: daysAgo(500),
    startDate: null,
    endDate: null,
    updatedAt: when,
    costEntries: (p.costs ?? []).map((amount) => ({ category: p.category ?? "materials", amount, txnDate: when })),
    invoices: (p.invoices ?? []).map((amount) => ({ amount, status: "open", txnDate: when })),
  };
}
const fin = (p: Parameters<typeof input>[0], c: Partial<FinancialContext> = {}): JobFinancials =>
  computeJobFinancials(input(p), ctx(c));

const emptyHealth = () => computeDataHealth([], NOW, null);

/** A job row as the database holds it, for the stand-in above. */
function row(p: {
  id: string;
  status?: string;
  contract?: number | null;
  estimate?: number | null;
  percent?: number | null;
  invoices?: { amount: number; daysAgo: number }[];
  costs?: { amount: number; daysAgo: number; category?: string; type?: string }[];
  createdDaysAgo?: number;
}, now: Date) {
  return {
    id: p.id,
    connectionId: "c1",
    name: p.id,
    customerName: null,
    status: p.status ?? "open",
    statusOverride: null,
    category: null,
    estimatedRevenue: p.contract ?? null,
    manualContractValue: null,
    estimatedCost: p.estimate ?? null,
    estimatedCostSource: p.estimate != null ? "manual" : null,
    percentCompleteOverride: p.percent ?? null,
    qboCreatedAt: daysAgo(p.createdDaysAgo ?? 500, now),
    startDate: null,
    endDate: null,
    updatedAt: now,
    missingSince: null,
    costEntries: (p.costs ?? []).map((c, i) => ({
      category: c.category ?? "materials",
      amount: c.amount,
      txnDate: daysAgo(c.daysAgo, now),
      qboSourceType: c.type ?? "Bill",
      qboSourceId: `${p.id}-c${i}`,
    })),
    invoices: (p.invoices ?? []).map((inv) => ({ amount: inv.amount, status: "open", txnDate: daysAgo(inv.daysAgo, now) })),
  };
}

beforeEach(() => {
  db.connection = {
    id: "c1",
    userId: "u1",
    targetMarginPct: 25,
    overheadEnabled: false,
    overheadMethod: null,
    overheadValue: null,
    lastSyncedAt: new Date(),
    laborBurdenPct: 0,
    laborBurdenSetAt: null,
    basisChangedAt: null,
    emailTimezone: "America/Los_Angeles",
  };
  db.jobs = [];
});

// ---------------------------------------------------------------------------
// 1. The dashboard's margin tile
// ---------------------------------------------------------------------------

describe("the dashboard's margin tile (audit item 1)", () => {
  const fiveOpenJobs = () => [
    fin({ id: "A", invoices: [40_000], costs: [30_000] }),
    fin({ id: "B", invoices: [25_000], costs: [20_000] }),
    fin({ id: "C", invoices: [10_000], costs: [500] }), // a deposit
    fin({ id: "D", invoices: [500], costs: [12_000] }), // materials bought before the first bill
    fin({ id: "E", invoices: [18_000], costs: [15_000] }),
  ];

  it("is Job Gross Profit over the same jobs' revenue, not an average of margins to date", () => {
    const jobs = fiveOpenJobs();
    const plainAverage = jobs.reduce((s, j) => s + j.grossMarginPct!, 0) / jobs.length;
    expect(formatPct(plainAverage)).toBe("-428.7%"); // what the tile used to show
    const totals = computeDashboardTotals(jobs, [], emptyHealth(), 25);
    expect(totals.jobGrossProfit).toBe(16_000);
    expect(formatPct(totals.avgJobMarginPct)).toBe("17.1%");
    expect(totals.avgJobMarginPct).toBeCloseTo(totals.jobGrossProfit! / 93_500);
  });

  it("leaves out jobs whose profit can't be worked out, as Job Gross Profit does", () => {
    const jobs = [...fiveOpenJobs(), fin({ id: "F", invoices: [50_000] }), fin({ id: "G", costs: [9_000] })];
    const totals = computeDashboardTotals(jobs, [], emptyHealth(), 25);
    expect(totals.jobGrossProfit).toBe(16_000);
    expect(formatPct(totals.avgJobMarginPct)).toBe("17.1%");
  });

  it("matches the brief's blended margin over the same jobs", async () => {
    const now = new Date();
    db.jobs = [
      row({ id: "A", invoices: [{ amount: 40_000, daysAgo: 3 }], costs: [{ amount: 30_000, daysAgo: 3 }] }, now),
      row({ id: "C", invoices: [{ amount: 10_000, daysAgo: 3 }], costs: [{ amount: 500, daysAgo: 3 }] }, now),
      row({ id: "D", invoices: [{ amount: 500, daysAgo: 3 }], costs: [{ amount: 12_000, daysAgo: 3 }] }, now),
    ];
    const dashboard = await getConnectionProfitData("c1", now, { statusFilter: "open" });
    const brief = await computeConnectionMetrics("c1", now);
    expect(dashboard.totals.avgJobMarginPct).toBeCloseTo(brief.totals.blendedMarginPct!);
    expect(dashboard.totals.avgJobMarginPct).toBeCloseTo((50_500 - 42_500) / 50_500);
  });

  it("is labelled Margin to Date on the Active tab and Job Margin otherwise", () => {
    const src = read("app/dashboard/page.tsx");
    expect(src).toContain('label={statusFilter === "open" ? "Margin to Date" : "Job Margin"}');
    expect(src).not.toContain("Average Job Margin");
  });
});

// ---------------------------------------------------------------------------
// 2. Float residue and credits
// ---------------------------------------------------------------------------

describe("revenue and costs in cents, and credits past the invoices (audit item 2)", () => {
  it("rounds to the cent before testing or dividing, so credits that cancel the invoices give no margin", () => {
    const amounts = [3191.49, 2186.53, 2064.42, -7442.44];
    expect(amounts.reduce((s, a) => s + a, 0)).not.toBe(0); // 9.09e-13: the residue
    const f = fin({ id: "Residue", status: "closed", invoices: amounts, costs: [1800] }, { targetMarginPct: 25 });
    expect(f.revenue).toBe(0);
    expect(f.profitabilityAvailable).toBe(false);
    expect(f.grossMarginPct).toBeNull();
    expect(f.unavailableReason).toBe("Credits on this job cancel out its invoices, so there is no revenue to measure a margin against.");
    expect(f.flags).not.toContain("below_target_margin");
    // Used to read "Margin is 197,912,092,999,679,920.0 points below your 25% target".
    const items = computeNeedsAttentionForJob(f);
    expect(items.map((i) => i.issueCode)).toEqual(["costs_no_revenue_completed"]);
    expect(items.some((i) => /points below/.test(i.issue))).toBe(false);
  });

  it("gives no margin when credits are more than the invoices, and says why", () => {
    const f = fin({ id: "Credit", status: "closed", invoices: [1000, -1500], costs: [800] });
    expect([f.revenue, f.profitabilityAvailable, f.grossProfit, f.grossMarginPct]).toEqual([-500, false, null, null]);
    expect(f.unavailableReason).toBe(
      "Credits and refunds on this job add up to more than its invoices, so there is no revenue to measure a margin against."
    );
    expect(f.dataConfidence).toBe("insufficient_data");
    expect(computeNeedsAttentionForJob(f).map((i) => i.issue)).toEqual([
      "Job is marked completed but its credits add up to more than its invoices",
    ]);
    // Still a completed job with something to sort out, on Data Health.
    expect(computeDataHealth([f], NOW, null).completedJobsWithUnresolvedActivity.map((j) => j.jobId)).toEqual(["Credit"]);
  });

  it("gives no margin when supplier credits are more than the costs", () => {
    const f = fin({ id: "Vendor credit", invoices: [1000], costs: [500, -700] });
    expect([f.costs, f.profitabilityAvailable, f.grossMarginPct]).toEqual([-200, false, null]);
    expect(f.unavailableReason).toContain("Supplier credits");
    // Used to count as available with profit and no margin.
    const onlyCredit = fin({ id: "Only a credit", costs: [-300] });
    expect([onlyCredit.profitabilityAvailable, onlyCredit.grossProfit]).toEqual([false, null]);
  });

  it("rounds each category to the cent and drops one that nets to nothing", () => {
    const f = fin({ id: "Cats", invoices: [5000], costs: [0.1, 0.2, 1000] });
    expect(f.costs).toBe(1000.3);
    expect(f.costByCategory).toEqual({ materials: 1000.3 });
    const cip = computeJobFinancials(
      {
        ...input({ id: "CIP", invoices: [5000], costs: [1000] }),
        costEntries: [
          { category: "materials", amount: 1000, txnDate: daysAgo(5) },
          { category: "other", amount: 3191.49 + 2186.53 + 2064.42, txnDate: daysAgo(5) },
          { category: "other", amount: -7442.44, txnDate: daysAgo(5) },
        ],
      },
      ctx()
    );
    expect(cip.costByCategory).toEqual({ materials: 1000 });
  });

  it("never lets NaN or Infinity through", () => {
    expect([toCents(NaN), toCents(Infinity), toCents(-Infinity), Object.is(toCents(-0.001), -0)]).toEqual([0, 0, 0, false]);
    const f = computeJobFinancials(
      { ...input({ id: "Bad", invoices: [1000], costs: [500] }), invoices: [{ amount: NaN, status: "open", txnDate: daysAgo(5) }] },
      ctx()
    );
    expect(f.revenue).toBe(0);
    for (const v of [f.revenue, f.costs, f.grossMarginPct ?? 0]) expect(Number.isFinite(v)).toBe(true);
    const totals = computeDashboardTotals([f], [], emptyHealth(), null);
    for (const v of [totals.revenue, totals.trackedJobCosts, totals.avgJobMarginPct ?? 0]) expect(Number.isFinite(v)).toBe(true);
  });

  it("reads a job billed exactly to its earned revenue as billed level, not behind", () => {
    // 0.1 + 0.2 of a contract: cost-to-cost gives 30,000.000000000004 earned.
    const f = fin({ id: "Level", contract: 100_000, estimate: 70_000, invoices: [30_000], costs: [7000, 14_000] });
    expect(f.wip!.earnedRevenue).toBe(30_000);
    expect(f.wip!.overUnderBilling).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 3. Forecasts from billing with no cost estimate
// ---------------------------------------------------------------------------

describe("forecasts from billing on a job with no cost estimate (audit item 3)", () => {
  const deposit = { id: "Deposit", contract: 30_000, invoices: [15_000], costs: [6_000] };

  it("is low confidence and not acted on, however much is billed", () => {
    const job = input(deposit);
    const f = computeJobFinancials(job, ctx({ targetMarginPct: 70 }));
    const fc = computeForecastAtCompletion(job, f, NOW);
    expect([fc.available, fc.progressSource, formatPct(fc.forecastMarginPct)]).toEqual([true, "billing", "60.0%"]);
    expect(fc.confidence).toBe("low");
    expect(fc.method).toContain("With no cost estimate this is an early read");
    expect(forecastIsActionable(f, fc)).toBe(false);
    // So no "forecast below target" item, alert or feed item from it.
    expect(computeNeedsAttentionForJob(f, { forecast: fc }).some((i) => i.issueCode === "forecast_below_target")).toBe(false);
    const feed = computeOpportunityFeed({
      now: NOW,
      jobs: [f],
      forecasts: new Map([[f.jobId, fc]]),
      mixes: new Map(),
      typeLabel: (k) => k,
      estimateFlags: [],
    });
    expect(feed.items.some((i) => i.kind === "open_job_forecast")).toBe(false);
  });

  it("is still a firm forecast from billing once there is a cost estimate", () => {
    const job = input({ ...deposit, estimate: 24_000 });
    const f = computeJobFinancials(job, ctx());
    const fc = computeForecastAtCompletion(job, f, NOW);
    expect(fc.confidence).toBe("medium");
    expect(formatPct(fc.forecastMarginPct)).toBe("20.0%");
    expect(forecastIsActionable(f, fc)).toBe(true);
  });

  it("leaves a percent complete entered by the contractor as it was", () => {
    const job = input({ ...deposit, percent: 50 });
    const f = computeJobFinancials(job, ctx());
    const fc = computeForecastAtCompletion(job, f, NOW);
    expect([fc.progressSource, fc.confidence, formatPct(fc.forecastMarginPct)]).toEqual(["manual", "high", "60.0%"]);
    expect(forecastIsActionable(f, fc)).toBe(true);
  });

  it("is refused by the shared rule even when a forecast says medium", () => {
    const f = fin(deposit);
    const fc = { ...computeForecastAtCompletion(input(deposit), f, NOW), confidence: "medium" as const };
    expect(forecastIsActionable(f, fc)).toBe(false);
  });

  it("gets the job page's too-early text, not a forecast", () => {
    const src = read("app/dashboard/jobs/[jobId]/page.tsx");
    expect(src).toContain('fc.progressSource === "billing" && (f.estimatedCost == null || f.estimatedCost <= 0)');
    expect(src).toContain("with no cost estimate a deposit billed ahead of the work makes the forecast run high");
  });
});

// ---------------------------------------------------------------------------
// 4. Idle open jobs on day one
// ---------------------------------------------------------------------------

describe("idle open jobs (audit item 4)", () => {
  /** 8 live jobs and 42 old customers QuickBooks still has as active. */
  function dayOne(now: Date) {
    const live = Array.from({ length: 8 }, (_, i) =>
      row(
        {
          id: `Live ${i + 1}`,
          contract: 40_000,
          estimate: 30_000,
          invoices: [{ amount: 12_000, daysAgo: 4 }],
          costs: [{ amount: 9_000, daysAgo: 6 }, { amount: 1_000, daysAgo: 2, category: "labor" }],
        },
        now
      )
    );
    const old = Array.from({ length: 42 }, (_, i) =>
      row({ id: `Old customer ${i + 1}`, invoices: [{ amount: 2_500, daysAgo: 400 + i }] }, now)
    );
    return [...live, ...old];
  }

  it("leaves them out of Data Health's job lists and grade, and counts them once", () => {
    const jobs = dayOne(NOW).map((r) =>
      computeJobFinancials(
        {
          ...input({ id: r.id }),
          estimatedRevenue: r.estimatedRevenue,
          estimatedCost: r.estimatedCost,
          qboCreatedAt: r.qboCreatedAt,
          costEntries: r.costEntries,
          invoices: r.invoices,
        },
        ctx()
      )
    );
    const health = computeDataHealth(jobs, NOW, null);
    expect(health.idleOpenJobs).toHaveLength(42);
    expect([health.jobsMissingCosts.length, health.staleJobs.length, health.jobsMissingEstimates.length]).toEqual([0, 0, 0]);
    expect([health.totalJobs, health.jobsMissingData, health.overallConfidence]).toEqual([8, 0, "high"]);
    // One Data Issue for all 42, not 84.
    expect(computeDashboardTotals(jobs, [], health, 25).dataIssues).toBe(1);
  });

  it("keeps them out of Needs Your Attention, and the brief still gets its summary", async () => {
    const now = new Date();
    db.jobs = dayOne(now);
    const data = await getConnectionProfitData("c1", now, { statusFilter: "open" });
    expect(data.needsAttention.filter((i) => i.jobName.startsWith("Old customer"))).toEqual([]);
    expect(data.totals.dataIssues).toBe(1);
    const brief = await computeConnectionMetrics("c1", now);
    // "low" here sends a data-health notice instead of the AI summary (digest.ts).
    expect(brief.briefDataHealth.overallConfidence).toBe("high");
    expect(brief.briefJobIds.some((id) => id.startsWith("Old customer"))).toBe(false);
    expect(brief.topConcerns.some((j) => j.jobName.startsWith("Old customer"))).toBe(false);
    expect(brief.briefDataHealth.idleOpenJobs).toHaveLength(42);
    expect(brief.dataHealth.idleOpenJobs).toHaveLength(42);
  });

  it("puts the one summary line on the dashboard, with the way to mark them finished", () => {
    const src = read("app/dashboard/page.tsx");
    expect(src).toContain("with no activity in 90 days: mark{\" \"}");
    expect(src).toContain('href="/dashboard/data-health"');
  });

  it("uses the WIP schedule's rule, so the count matches what close-idle marks finished", () => {
    const at90 = fin({ id: "Ninety", invoices: [1000], costs: [500], lastDaysAgo: 90 });
    const at91 = fin({ id: "Ninety-one", invoices: [1000], costs: [500], lastDaysAgo: 91 });
    expect(computeDataHealth([at90, at91], NOW, null).idleOpenJobs.map((j) => j.jobId)).toEqual(["Ninety-one"]);
  });
});

// ---------------------------------------------------------------------------
// 5. The dashboard's margin trend
// ---------------------------------------------------------------------------

describe("the dashboard's margin trend (audit item 5)", () => {
  const march = new Date("2026-03-10T00:00:00Z");
  const may = new Date("2026-05-20T00:00:00Z");

  it("counts each finished job once, in the month it finished, at its whole-job margin", () => {
    const job = computeJobFinancials(
      {
        ...input({ id: "Kitchen", status: "closed" }),
        costEntries: [{ category: "materials", amount: 8_000, txnDate: march }],
        invoices: [{ amount: 10_000, status: "paid", txnDate: may }],
      },
      ctx()
    );
    // By transaction month it drew March as a loss with no revenue and May as 100%.
    expect(marginTrendByPeriod([job], "monthly", NOW)).toEqual([{ period: "2026-05", revenue: 10_000, costs: 8_000, marginPct: 0.2 }]);
    expect(marginTrendByPeriod([job], "quarterly", NOW)).toEqual([{ period: "2026-Q2", revenue: 10_000, costs: 8_000, marginPct: 0.2 }]);
  });

  it("is revenue-weighted across the jobs that finished in a period, and skips open or incomplete jobs", () => {
    const done = (id: string, revenue: number, cost: number, when: Date, status = "closed") =>
      computeJobFinancials(
        {
          ...input({ id, status }),
          costEntries: cost ? [{ category: "materials", amount: cost, txnDate: when }] : [],
          invoices: revenue ? [{ amount: revenue, status: "paid", txnDate: when }] : [],
        },
        ctx()
      );
    const points = marginTrendByPeriod(
      [done("Big", 90_000, 72_000, may), done("Small", 10_000, 2_000, may), done("Open", 5_000, 1_000, may, "open"), done("No cost", 4_000, 0, may)],
      "monthly",
      NOW
    );
    expect(points).toEqual([{ period: "2026-05", revenue: 100_000, costs: 74_000, marginPct: 0.26 }]);
  });

  it("is what getMarginTrend returns for the dashboard, labor burden included", async () => {
    db.connection.laborBurdenPct = 25;
    db.jobs = [
      {
        ...row({ id: "Bath", status: "closed", invoices: [{ amount: 10_000, daysAgo: 0 }] }, NOW),
        costEntries: [
          { category: "materials", amount: 4_000, txnDate: march, qboSourceType: "Bill", qboSourceId: "b1" },
          { category: "labor", amount: 2_000, txnDate: march, qboSourceType: "TimeActivity", qboSourceId: "t1" },
        ],
        invoices: [{ amount: 10_000, status: "paid", txnDate: may }],
      },
      row({ id: "Still open", invoices: [{ amount: 1_000, daysAgo: 3 }], costs: [{ amount: 900, daysAgo: 3 }] }, NOW),
    ];
    const points = await getMarginTrend("c1", "monthly", NOW);
    expect(points).toEqual([{ period: "2026-05", revenue: 10_000, costs: 6_500, marginPct: 0.35 }]);
  });
});

// ---------------------------------------------------------------------------
// 6. The bank-ready WIP report and CSV
// ---------------------------------------------------------------------------

describe("the bank-ready WIP report and CSV (audit item 6)", () => {
  it("is as of today in the company's time zone", () => {
    // 7 pm in Los Angeles on Oct 19 is already Oct 20 in UTC.
    const evening = new Date("2026-10-20T02:00:00Z");
    expect(wipReportDay(evening, "America/Los_Angeles").toISOString()).toBe("2026-10-19T00:00:00.000Z");
    expect(wipReportDay(evening, "Europe/London").toISOString()).toBe("2026-10-20T00:00:00.000Z");
    expect(wipReportDay(evening, null).toISOString()).toBe("2026-10-19T00:00:00.000Z"); // America/New_York
  });

  it("leaves out invoices and bills dated after today", async () => {
    const now = new Date();
    db.jobs = [
      row(
        {
          id: "Addition",
          contract: 100_000,
          estimate: 80_000,
          invoices: [{ amount: 30_000, daysAgo: 10 }, { amount: 25_000, daysAgo: -5 }],
          costs: [{ amount: 20_000, daysAgo: 8 }, { amount: 12_000, daysAgo: -3 }],
        },
        now
      ),
    ];
    const asOf = wipReportDay(now, db.connection.emailTimezone);
    const data = await getConnectionProfitData("c1", now, { statusFilter: "open", asOf });
    const s = buildWipSchedule(data.lifetimeJobs, now);
    expect(s.inProgress.map((r) => [r.billedToDate, r.costToDate, r.percentComplete])).toEqual([[30_000, 20_000, 0.25]]);
  });

  it("says when QuickBooks was last read, in the company's time zone", () => {
    const synced = new Date("2026-10-19T09:05:00Z");
    const basis = wipReportBasis(
      { lastSyncedAt: synced, lastSyncStatus: "success", lastSyncError: null, fullSyncContinueAt: null, emailTimezone: "America/Los_Angeles" },
      { paused: false }
    );
    expect(basis.dataAsOf).toBe(`QuickBooks data as of ${formatDateTime(synced, "America/Los_Angeles")}`);
    expect(basis.dataAsOf).toContain("PDT");
    expect(basis.warning).toBeNull();
  });

  it("warns when the figures may be behind the books", () => {
    type Company = Parameters<typeof wipReportBasis>[0];
    const base: Company = {
      lastSyncedAt: new Date("2026-09-01T09:00:00Z"),
      lastSyncStatus: "success",
      lastSyncError: null,
      fullSyncContinueAt: null,
      emailTimezone: "America/Chicago",
    };
    const warn = (over: Partial<Company>, paused = false) => wipReportBasis({ ...base, ...over }, { paused }).warning;
    expect(warn({ lastSyncStatus: "error", lastSyncError: "Something broke" })).toMatch(/^May not be up to date: the most recent update from QuickBooks didn't finish/);
    expect(warn({ lastSyncStatus: "error", lastSyncError: "Your QuickBooks connection has expired or was disconnected. Reconnect it." })).toMatch(
      /^Not up to date: QuickBooks needs to be reconnected/
    );
    expect(warn({}, true)).toMatch(/^Not up to date: updates from QuickBooks are paused/);
    expect(warn({ fullSyncContinueAt: new Date("2026-09-02T00:00:00Z") })).toMatch(/^May be incomplete: a full read/);
    expect(warn({ lastSyncedAt: null })).toBe("Not up to date: nothing has been read from QuickBooks for this company yet.");
    expect(warn({})).toBeNull();
  });

  it("is the same day on Money Owed, so its unbilled work and invoices tie with the WIP page", async () => {
    const now = new Date();
    db.jobs = [
      row(
        {
          id: "Addition",
          contract: 100_000,
          estimate: 80_000,
          invoices: [{ amount: 10_000, daysAgo: 10 }, { amount: 25_000, daysAgo: -5 }],
          costs: [{ amount: 40_000, daysAgo: 8 }, { amount: 12_000, daysAgo: -3 }],
        },
        now
      ),
    ];
    const asOf = wipReportDay(now, db.connection.emailTimezone);
    const all = await getConnectionProfitData("c1", now, { asOf });
    const wip = buildWipSchedule((await getConnectionProfitData("c1", now, { statusFilter: "open", asOf })).lifetimeJobs, now);
    const invoice = (id: string, d: number, openBalance: number) => ({
      jobId: "Addition", jobName: "Addition", customerName: null, qboInvoiceId: id, docNumber: id, txnDate: daysAgo(d, now), dueDate: null, openBalance,
    });
    const owed = computeMoneyOwed({ now, jobs: all.lifetimeJobs, openInvoices: [invoice("1001", 10, 10_000), invoice("1002", -5, 25_000)], asOf });
    // $40,000 of the $80,000 estimate spent: half of $100,000 earned, $10,000 billed.
    expect(owed.unbilled.total).toBe(40_000);
    expect(owed.unbilled.total + owed.unbilled.smallTotal).toBe(wip.totals.underBilled);
    expect(owed.unpaid.jobs[0].invoiceList.map((i) => i.qboInvoiceId)).toEqual(["1001"]);
    const src = read("app/dashboard/money-owed/page.tsx");
    expect(src).toContain("const asOf = wipReportDay(now, connection.emailTimezone);");
    expect(src).toContain("getConnectionProfitData(connection.id, now, { asOf })");
    expect(src).toMatch(/targetFilledEstimates: new Set\(filled\.map\(\(j\) => j\.id\)\),\s*asOf,/);
  });

  it("is used by the report, the CSV and the WIP page alike", () => {
    for (const file of ["app/reports/wip/page.tsx", "app/api/wip/export/route.ts", "app/dashboard/wip/page.tsx"]) {
      const src = read(file);
      expect({ file, asOf: src.includes("asOf: wipReportDay(now, connection.emailTimezone)") }).toEqual({ file, asOf: true });
    }
    for (const file of ["app/reports/wip/page.tsx", "app/api/wip/export/route.ts"]) {
      const src = read(file);
      expect({ file, basis: src.includes("wipReportBasis(connection, { paused })") && src.includes("basis.warning") && src.includes("basis.dataAsOf") }).toEqual({
        file,
        basis: true,
      });
    }
  });
});

// ---------------------------------------------------------------------------
// 7. The feed's unbilled work
// ---------------------------------------------------------------------------

describe("the feed's unbilled work item (audit item 7)", () => {
  const feedOf = (jobs: JobFinancials[]) =>
    computeOpportunityFeed({ now: NOW, jobs, forecasts: new Map(), mixes: new Map(), typeLabel: (k) => k, estimateFlags: [] });

  it("is left out on a job the WIP schedule leaves out, as Money Owed does", () => {
    // Entered as 20% complete with no cost estimate: $20,000 earned, $1,000 billed.
    const early = fin({ id: "Early", contract: 100_000, percent: 20, invoices: [1_000], costs: [3_000] });
    expect(early.wip!.overUnderBilling).toBe(-19_000);
    expect(wipCountsInTotals(early, NOW)).toBe(false);
    const out = feedOf([early]);
    expect(out.items.some((i) => i.kind === "underbilled")).toBe(false);
    expect([out.summary.unbilledWork, out.summary.billingChecked]).toEqual([0, 0]);
    const owed = computeMoneyOwed({ now: NOW, openInvoices: [], jobs: [early] });
    expect(owed.unbilled.total).toBe(0);
  });

  it("still names unbilled work on a job the schedule measures, at the WIP figure", () => {
    const measured = fin({ id: "Measured", contract: 100_000, estimate: 80_000, invoices: [10_000], costs: [40_000] });
    const out = feedOf([measured]);
    const item = out.items.find((i) => i.kind === "underbilled")!;
    const wip = buildWipSchedule([measured], NOW);
    expect(item.impact).toBe(40_000);
    expect(item.impact).toBe(wip.totals.underBilled);
    expect(out.summary.billingChecked).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 8. Labor counted twice
// ---------------------------------------------------------------------------

describe("labor counted twice (audit item 8)", () => {
  const at = new Date("2026-10-01T00:00:00Z");
  const labor = (qboSourceType: string, category = "labor") => ({ qboSourceType, category, txnDate: at });

  it("catches timesheets plus wages paid by check or bill, not only payroll journal entries", () => {
    const jobs = [
      { id: "check", name: "Wages by check", costEntries: [labor("TimeActivity"), labor("Purchase")] },
      { id: "bill", name: "Payroll bill", costEntries: [labor("TimeActivity"), labor("Bill")] },
      { id: "journal", name: "Payroll journal", costEntries: [labor("TimeActivity"), labor("JournalEntry")] },
      { id: "sub", name: "Sub on the job", costEntries: [labor("TimeActivity"), labor("Bill", "subcontractor")] },
      { id: "checks-only", name: "Checks only", costEntries: [labor("Purchase"), labor("Purchase")] },
    ];
    expect(findDoubleLabor(jobs, NOW).map((j) => j.jobId)).toEqual(["check", "bill", "journal"]);
  });
});

// ---------------------------------------------------------------------------
// 9. Copy
// ---------------------------------------------------------------------------

describe("copy (audit item 9)", () => {
  it("says how many insights in words, with no dash", () => {
    const src = read("app/dashboard/intelligence/RefreshAnalysisButton.tsx");
    expect(src).toContain('`Analysis refreshed: ${data.count} ${data.count === 1 ? "insight" : "insights"}.`');
    expect(src).not.toContain("insight(s)");
  });

  it("tells a new owner what connecting involves", () => {
    const src = read("app/dashboard/page.tsx").replace(/\s+/g, " ");
    expect(src).toContain(
      "Connect your QuickBooks Online company to see your job profitability. It takes about two minutes, JobProfitAI only reads your books, and your first numbers are ready in a few minutes. QuickBooks Desktop isn&apos;t supported."
    );
  });

  it("uses no em or en dashes in the text changed for this audit", () => {
    for (const file of [
      "lib/profitability.ts",
      "lib/forecastRules.ts",
      "lib/marginTrend.ts",
      "lib/wipSchedule.ts",
      "lib/opportunities.ts",
      "app/dashboard/page.tsx",
      "app/reports/wip/page.tsx",
      "app/api/wip/export/route.ts",
      "app/dashboard/wip/page.tsx",
      "app/dashboard/jobs/[jobId]/page.tsx",
      "app/dashboard/intelligence/RefreshAnalysisButton.tsx",
    ]) {
      expect({ file, dashes: /[–—]/.test(read(file)) }).toEqual({ file, dashes: false });
    }
  });
});
