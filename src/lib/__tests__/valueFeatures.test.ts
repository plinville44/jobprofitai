import { describe, it, expect } from "vitest";
import { burdenedAmount, laborBurdenOf, type JobFinancials, type WipFigures } from "../profitability";
import { computeEstimateCheck, costFromQuantities } from "../opportunities";
import { computeMoneyOwed } from "../moneyOwed";
import { buildWipSchedule } from "../wipSchedule";
import { computeMarginTrend, trendMonths } from "../marginTrend";
import { compareWithQuickBooks } from "../qboCheck";

const NOW = new Date("2026-09-25T12:00:00Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000);

let seq = 0;
function job(p: Partial<JobFinancials> & { revenue: number; costs: number }): JobFinancials {
  seq++;
  const { revenue, costs } = p;
  const available = revenue > 0 && costs > 0;
  return {
    jobId: p.jobId ?? `j${seq}`,
    jobName: p.jobName ?? `Job ${String(seq).padStart(3, "0")}`,
    customerName: p.customerName ?? null,
    status: p.status ?? "closed",
    category: p.category ?? null,
    revenue,
    estimatedRevenue: p.estimatedRevenue ?? null,
    costs,
    estimatedCost: p.estimatedCost ?? null,
    costByCategory: { materials: costs },
    profitabilityAvailable: available,
    unavailableReason: null,
    grossProfit: available ? revenue - costs : null,
    grossMarginPct: available ? (revenue - costs) / revenue : null,
    fullyLoadedProfit: null,
    fullyLoadedMarginPct: null,
    targetMarginPct: p.targetMarginPct === undefined ? 30 : p.targetMarginPct,
    varianceVsEstimate: null,
    varianceVsEstimatePct: null,
    dataConfidence: "high",
    confidenceReasons: [],
    lastFinancialActivity: p.lastFinancialActivity === undefined ? daysAgo(10) : p.lastFinancialActivity,
    qboCreatedAt: p.qboCreatedAt ?? daysAgo(200),
    wip: p.wip ?? null,
    flags: [],
  };
}

const wip = (w: Partial<WipFigures> & { percentComplete: number; earnedRevenue: number; overUnderBilling: number }): WipFigures => ({
  percentCompleteSource: "cost",
  costPastEstimate: false,
  ...w,
});

describe("labor burden", () => {
  it("adds the burden to time-entry labor only", () => {
    expect(burdenedAmount({ amount: 1000, qboSourceType: "TimeActivity" }, 0.25)).toBe(1250);
    expect(burdenedAmount({ amount: 1000, qboSourceType: "Bill" }, 0.25)).toBe(1000);
    expect(burdenedAmount({ amount: 1000, qboSourceType: "TimeActivity" }, 0)).toBe(1000);
  });

  it("reads the setting as a fraction and ignores nonsense", () => {
    expect(laborBurdenOf({ laborBurdenPct: 22.5 })).toBeCloseTo(0.225);
    expect(laborBurdenOf({ laborBurdenPct: null })).toBe(0);
    expect(laborBurdenOf({ laborBurdenPct: -5 })).toBe(0);
    expect(laborBurdenOf({ laborBurdenPct: 250 })).toBe(0);
  });

  it("is named in the QuickBooks check, on top of the timesheet labor", () => {
    const r = compareWithQuickBooks(
      { revenue: 1000, postedCosts: 500, timesheetLabor: 400, parentCustomerCosts: 0, laborBurden: 0.25 },
      { income: 1000, costs: 500 }
    );
    expect(r.allMatch).toBe(true);
    expect(r.notes[0]).toContain("25% labor burden, another $100.00");
  });
});

describe("estimates costed from their quantities", () => {
  const rate = { perHour: 40, hours: 2000, burden: 0.2 };

  it("costs hours at the labor rate and items at their purchase cost, and skips lump sums", () => {
    const qc = costFromQuantities(
      [
        { n: "Framing labor", c: "labor", a: 3_600, q: 40 }, // $90 an hour: hours
        { n: "Demo", c: "labor", a: 4_000, q: 1 }, // $4,000 for 1: a lump sum
        { n: "Drywall sheet", c: "materials", a: 1_000, q: 50, u: 14 },
        { n: "Labor", c: "labor", a: 4_000, q: 1, u: 35 }, // item cost $35, priced $4,000 for 1: a lump sum
        { n: "Permit", c: "other", a: 500 }, // no quantity
      ],
      rate
    );
    expect(qc.lines.map((l) => [l.name, l.basis, l.cost])).toEqual([
      ["Framing labor", "labor_rate", 1_600],
      ["Drywall sheet", "item_cost", 700],
    ]);
    expect(qc.cost).toBe(2_300);
    expect(qc.costedPrice).toBe(4_600);
  });

  it("trusts lines judged before merging, and adds the burden to labor items' purchase cost", () => {
    const qc = costFromQuantities(
      [
        // 40 hours at $80 plus a $4,000 lump, merged: only the hours count.
        { n: "Labor", c: "labor", a: 7_200, q: 40, qa: 3_200 },
        { n: "Tile setter", c: "labor", a: 1_200, q: 20, u: 30, qa: 1_200 },
      ],
      rate
    );
    expect(qc.lines.map((l) => [l.name, l.basis, l.price, l.cost])).toEqual([
      ["Labor", "labor_rate", 3_200, 1_600],
      ["Tile setter", "item_cost", 1_200, 20 * 30 * 1.2],
    ]);
    expect(qc.costedPrice).toBe(4_400);
  });

  it("follows the estimate's own price when fully costed, with no past jobs needed", () => {
    const lines = [
      { n: "Framing labor", c: "labor" as const, a: 3_600, q: 40 },
      { n: "Drywall sheet", c: "materials" as const, a: 1_000, q: 50, u: 14 },
    ];
    const r = computeEstimateCheck({ amount: 4_600, lines, targetPct: 30, history: [], now: NOW, laborRate: rate });
    expect(r.method).toBe("quantities");
    expect(r.expectedCost).toBeCloseTo(2_300);
    expect(r.expectedMarginPct).toBeCloseTo(0.5);
    expect(r.status).toBe("on_target");
    // Cut the labor price in half and the same job no longer reaches 30%.
    const cheap = computeEstimateCheck({
      amount: 2_800,
      lines: [{ ...lines[0], a: 1_800 }, lines[1]],
      targetPct: 30,
      history: [],
      now: NOW,
      laborRate: rate,
    });
    expect(cheap.status).toBe("below_target");
    expect(cheap.priceAtTarget).toBeCloseTo(2_300 / 0.7);
    expect(cheap.summary).toContain("Costed from its quantities");
  });

  it("checks the rest of a partly costed estimate at past jobs' rate", () => {
    const history = [1, 2, 3].map(() => ({ f: job({ revenue: 10_000, costs: 8_000, lastFinancialActivity: daysAgo(100) }), mix: null }));
    const r = computeEstimateCheck({
      amount: 10_000,
      lines: [
        { n: "Framing labor", c: "labor", a: 6_000, q: 100 },
        { n: "Other", c: "other", a: 4_000 },
      ],
      targetPct: 30,
      history,
      now: NOW,
      laborRate: rate,
    });
    expect(r.method).toBe("quantities");
    expect(r.expectedCost).toBeCloseTo(4_000 + 4_000 * 0.8);
    expect(r.quantityCoverage).toBeCloseTo(0.6);
    expect(r.confidence).toBe("low");
  });

  it("falls back to past jobs when too little of the price has quantities", () => {
    const history = [1, 2, 3].map(() => ({ f: job({ revenue: 10_000, costs: 8_000, lastFinancialActivity: daysAgo(100) }), mix: null }));
    const r = computeEstimateCheck({
      amount: 10_000,
      lines: [
        { n: "Framing labor", c: "labor", a: 2_000, q: 25 },
        { n: "Other", c: "other", a: 8_000 },
      ],
      targetPct: 30,
      history,
      now: NOW,
      laborRate: rate,
    });
    expect(r.method).toBe("whole_job");
  });
});

describe("money you're owed", () => {
  it("groups unpaid invoices by job and age, and totals only unpaid and unbilled", () => {
    const jobs = [
      job({
        jobId: "a",
        status: "open",
        revenue: 20_000,
        costs: 30_000,
        estimatedRevenue: 100_000,
        estimatedCost: 60_000,
        wip: wip({ percentComplete: 0.5, earnedRevenue: 50_000, overUnderBilling: -30_000 }),
      }),
      // Costs 25% past the estimate, billing still inside the contract: a possible change order.
      job({ jobId: "b", status: "open", revenue: 30_000, costs: 50_000, estimatedRevenue: 60_000, estimatedCost: 40_000, targetMarginPct: 20 }),
      // Idle 120 days: left out of unbilled and change orders.
      job({
        jobId: "c",
        status: "open",
        revenue: 0,
        costs: 10_000,
        estimatedRevenue: 50_000,
        estimatedCost: 20_000,
        lastFinancialActivity: daysAgo(120),
        wip: wip({ percentComplete: 0.5, earnedRevenue: 25_000, overUnderBilling: -25_000 }),
      }),
    ];
    const owed = computeMoneyOwed({
      now: NOW,
      jobs,
      openInvoices: [
        { jobId: "a", jobName: "A", customerName: null, txnDate: daysAgo(10), openBalance: 5_000 },
        { jobId: "a", jobName: "A", customerName: null, txnDate: daysAgo(75), openBalance: 2_000 },
        { jobId: "b", jobName: "B", customerName: null, txnDate: daysAgo(120), openBalance: 1_000 },
      ],
    });
    expect(owed.unpaid.total).toBe(8_000);
    expect(owed.unpaid.over60).toBe(3_000);
    expect(owed.unpaid.jobs[0].jobId).toBe("b"); // oldest first
    expect(owed.unpaid.jobs.find((j) => j.jobId === "a")!.buckets).toEqual([5_000, 0, 2_000, 0]);
    expect(owed.unbilled.jobs.map((j) => [j.jobId, j.amount])).toEqual([["a", 30_000]]);
    expect(owed.changeOrders.jobs.map((j) => [j.jobId, j.overBy])).toEqual([["b", 10_000]]);
    expect(owed.changeOrders.jobs[0].priceAtTarget).toBeCloseTo(12_500);
    expect(owed.total).toBe(38_000);
  });

  it("doesn't call an estimate filled in from the target margin a change order", () => {
    const b = job({ jobId: "b", status: "open", revenue: 30_000, costs: 50_000, estimatedRevenue: 60_000, estimatedCost: 40_000 });
    expect(computeMoneyOwed({ now: NOW, jobs: [b], openInvoices: [], targetFilledEstimates: new Set(["b"]) }).changeOrders.jobs).toEqual([]);
  });
});

describe("bank-ready WIP schedule", () => {
  it("lays out contracts in progress with totals, and last year's completed contracts", () => {
    const jobs = [
      job({
        jobId: "a",
        jobName: "Alpha",
        status: "open",
        revenue: 30_000,
        costs: 30_000,
        estimatedRevenue: 100_000,
        estimatedCost: 75_000,
        wip: wip({ percentComplete: 0.4, earnedRevenue: 40_000, overUnderBilling: -10_000 }),
      }),
      job({
        jobId: "b",
        jobName: "Bravo",
        status: "open",
        revenue: 30_000,
        costs: 10_000,
        estimatedRevenue: 50_000,
        wip: wip({ percentComplete: 0.5, percentCompleteSource: "manual", earnedRevenue: 25_000, overUnderBilling: 5_000 }),
      }),
      job({ jobId: "c", jobName: "Charlie", status: "open", revenue: 0, costs: 500 }), // active, nothing to measure
      job({ jobId: "d", jobName: "Delta", status: "open", revenue: 0, costs: 500, lastFinancialActivity: daysAgo(200) }), // idle
      job({ jobId: "e", jobName: "Echo", status: "closed", revenue: 20_000, costs: 15_000, lastFinancialActivity: daysAgo(90) }),
      job({ jobId: "f", jobName: "Foxtrot", status: "closed", revenue: 20_000, costs: 15_000, lastFinancialActivity: daysAgo(500) }),
    ];
    const s = buildWipSchedule(jobs, NOW);
    expect(s.inProgress.map((r) => r.jobId)).toEqual(["a", "b"]);
    const a = s.inProgress[0];
    expect(a).toMatchObject({ estimatedTotalCost: 75_000, estimatedGrossProfit: 25_000, underBilled: 10_000, overBilled: 0, costToComplete: 45_000, grossProfitToDate: 10_000 });
    // Entered 50% with no cost estimate: the estimate is what that implies.
    const b = s.inProgress[1];
    expect(b).toMatchObject({ percentFromEntry: true, estimatedTotalCost: 20_000, estimatedGrossProfit: 30_000, overBilled: 5_000, costToComplete: 10_000 });
    expect(s.totals).toMatchObject({ contract: 150_000, costToDate: 40_000, earnedRevenue: 65_000, billedToDate: 60_000, overBilled: 5_000, underBilled: 10_000, estimatedTotalCost: 95_000 });
    expect(s.notScheduled).toEqual([{ jobId: "c", jobName: "Charlie", needs: "contract" }]);
    expect(s.completed.map((r) => r.jobId)).toEqual(["e"]);
    expect(s.completedTotals.margin).toBeCloseTo(0.25);
  });

  it("projects an entered percent past the estimate instead of showing nothing left to spend", () => {
    const f = job({
      jobId: "g",
      status: "open",
      revenue: 40_000,
      costs: 60_000,
      estimatedRevenue: 100_000,
      estimatedCost: 50_000,
      wip: wip({ percentComplete: 0.5, percentCompleteSource: "manual", earnedRevenue: 50_000, overUnderBilling: -10_000 }),
    });
    const [r] = buildWipSchedule([f], NOW, new Set(["g"])).inProgress;
    expect(r).toMatchObject({ estimatedTotalCost: 120_000, estimatedGrossProfit: -20_000, costToComplete: 60_000, costFromTarget: true });
  });

  it("leaves a total blank rather than add up only the rows it knows", () => {
    const tiny = job({
      status: "open",
      revenue: 0,
      costs: 100,
      estimatedRevenue: 10_000,
      wip: wip({ percentComplete: 0.02, percentCompleteSource: "manual", earnedRevenue: 200, overUnderBilling: -200 }),
    });
    const s = buildWipSchedule([tiny], NOW);
    expect(s.inProgress[0].estimatedTotalCost).toBeNull();
    expect(s.totals.estimatedTotalCost).toBeNull();
    expect(s.totals.costToComplete).toBeNull();
  });
});

describe("margin by job type, month by month", () => {
  it("covers the last six calendar months", () => {
    expect(trendMonths(NOW)).toEqual(["2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09"]);
  });

  it("counts each finished job once, in the month it finished, and compares the last three months with the three before", () => {
    const at = (iso: string) => new Date(iso);
    const jobs = [
      // Remodels: 30% in spring, 20% in summer.
      job({ category: "remodel", revenue: 10_000, costs: 7_000, lastFinancialActivity: at("2026-04-10T00:00:00Z") }),
      job({ category: "remodel", revenue: 10_000, costs: 7_000, lastFinancialActivity: at("2026-05-10T00:00:00Z") }),
      job({ category: "remodel", revenue: 10_000, costs: 8_000, lastFinancialActivity: at("2026-08-10T00:00:00Z") }),
      job({ category: "remodel", revenue: 10_000, costs: 8_000, lastFinancialActivity: at("2026-09-10T00:00:00Z") }),
      // Too few roofs for a row.
      job({ category: "roofing", revenue: 5_000, costs: 4_000, lastFinancialActivity: at("2026-09-01T00:00:00Z") }),
      // Outside the window, and open: ignored.
      job({ category: "remodel", revenue: 10_000, costs: 1_000, lastFinancialActivity: at("2026-02-10T00:00:00Z") }),
      job({ category: "remodel", status: "open", revenue: 10_000, costs: 1_000 }),
    ];
    const t = computeMarginTrend(jobs, NOW);
    expect(t.byType.map((r) => r.type)).toEqual(["remodel"]);
    const r = t.byType[0];
    expect(r.jobs).toBe(4);
    expect(r.months.map((c) => c.jobs)).toEqual([1, 1, 0, 0, 1, 1]);
    expect(r.months[0].margin).toBeCloseTo(0.3);
    expect(r.months[2].margin).toBeNull();
    expect(r.change).toBeCloseTo(-0.1);
    expect(r.targetPct).toBe(30);
    expect(t.all!.jobs).toBe(5);
  });

  it("won't call one job a trend", () => {
    const jobs = [
      job({ category: "remodel", revenue: 10_000, costs: 7_000, lastFinancialActivity: new Date("2026-04-10T00:00:00Z") }),
      job({ category: "remodel", revenue: 10_000, costs: 8_000, lastFinancialActivity: new Date("2026-08-10T00:00:00Z") }),
      job({ category: "remodel", revenue: 10_000, costs: 8_000, lastFinancialActivity: new Date("2026-09-10T00:00:00Z") }),
    ];
    expect(computeMarginTrend(jobs, NOW).byType[0].change).toBeNull();
  });
});
