import { describe, it, expect } from "vitest";
import type { ForecastResult, JobFinancials } from "../profitability";
import {
  fmtTarget,
  categoryResults,
  computeActionOutcome,
  computeEstimateCheck,
  computeOpportunityFeed,
  contractEstimates,
  coreActuals,
  niceCeil,
  pricedMixForJob,
  pricedMixFromLines,
  type FeedInput,
  type PricedMix,
} from "../opportunities";

const NOW = new Date("2026-09-25T12:00:00Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000);

let seq = 0;
function job(p: Partial<JobFinancials> & { revenue: number; costs: number }): JobFinancials {
  seq++;
  const revenue = p.revenue;
  const costs = p.costs;
  const available = p.profitabilityAvailable ?? (revenue > 0 && costs > 0);
  return {
    jobId: p.jobId ?? `j${seq}`,
    jobName: p.jobName ?? `Job ${seq}`,
    customerName: p.customerName ?? `Customer ${seq}`,
    status: p.status ?? "closed",
    category: p.category ?? null,
    revenue,
    estimatedRevenue: p.estimatedRevenue ?? null,
    costs,
    estimatedCost: p.estimatedCost ?? null,
    costByCategory: p.costByCategory ?? { materials: costs },
    profitabilityAvailable: available,
    unavailableReason: null,
    grossProfit: available ? revenue - costs : null,
    grossMarginPct: available ? (revenue - costs) / revenue : null,
    fullyLoadedProfit: null,
    fullyLoadedMarginPct: null,
    targetMarginPct: p.targetMarginPct === undefined ? 30 : p.targetMarginPct,
    varianceVsEstimate: p.varianceVsEstimate ?? null,
    varianceVsEstimatePct: p.varianceVsEstimatePct ?? null,
    dataConfidence: "high",
    confidenceReasons: [],
    lastFinancialActivity: p.lastFinancialActivity === undefined ? daysAgo(30) : p.lastFinancialActivity,
    qboCreatedAt: p.qboCreatedAt ?? daysAgo(120),
    wip: p.wip ?? null,
    flags: [],
  };
}

function feed(jobs: JobFinancials[], extra: Partial<FeedInput> = {}) {
  return computeOpportunityFeed({
    now: NOW,
    jobs,
    forecasts: new Map(),
    mixes: new Map(),
    typeLabel: (k) => ({ remodel: "Remodel", roofing: "Roofing", painting: "Painting" })[k] ?? k,
    estimateFlags: [],
    ...extra,
  });
}

const mix = (shares: PricedMix["shares"]): PricedMix => ({ shares, coverage: 1, quoted: 1 });

describe("estimate price split", () => {
  it("uses accepted estimates, else the latest pending, and never rejected ones", () => {
    const e = (status: string, day: number, amount = 100) => ({ status, amount, txnDate: daysAgo(day) });
    expect(contractEstimates([e("Pending", 10), e("Accepted", 20), e("Closed", 5)]).map((x) => x.status)).toEqual(["Accepted", "Closed"]);
    expect(contractEstimates([e("Pending", 10), e("Pending", 3), e("Rejected", 1)]).map((x) => x.txnDate)).toEqual([daysAgo(3)]);
    expect(contractEstimates([e("Rejected", 1)])).toEqual([]);
  });

  it("splits the price across the four core parts and needs half the price in them", () => {
    const m = pricedMixFromLines([
      { n: "Labor", c: "labor", a: 6000 },
      { n: "Materials", c: "materials", a: 3000 },
      { n: "Overhead & profit", c: "other", a: 1000 },
    ]);
    expect(m!.shares.labor).toBeCloseTo(2 / 3);
    expect(m!.shares.materials).toBeCloseTo(1 / 3);
    expect(m!.coverage).toBeCloseTo(0.9);
    // Mostly one undifferentiated line: no usable split.
    expect(pricedMixFromLines([{ n: "Kitchen", c: "other", a: 9000 }, { n: "Labor", c: "labor", a: 1000 }])).toBeNull();
    // A single part is no split either.
    expect(pricedMixFromLines([{ n: "Labor", c: "labor", a: 9000 }])).toBeNull();
  });

  it("needs every estimate behind the contract to have lines", () => {
    const lines = [{ n: "Labor", c: "labor" as const, a: 500 }, { n: "Materials", c: "materials" as const, a: 500 }];
    expect(pricedMixForJob([{ amount: 1000, status: "Accepted", txnDate: daysAgo(9), lines }])).not.toBeNull();
    expect(pricedMixForJob([
      { amount: 1000, status: "Accepted", txnDate: daysAgo(9), lines },
      { amount: 200, status: "Accepted", txnDate: daysAgo(2), lines: null },
    ])).toBeNull();
  });

  it("spreads uncategorized cost across the core parts so they add up to the job", () => {
    const a = coreActuals({ costs: 10_000, costByCategory: { labor: 6000, materials: 2000, other: 2000 } })!;
    expect(a.labor).toBeCloseTo(7500);
    expect(a.materials).toBeCloseTo(2500);
    expect(coreActuals({ costs: 500, costByCategory: { other: 500 } })).toBeNull();
  });

  it("sets what was charged for each part against what it cost", () => {
    const f = job({ revenue: 20_000, costs: 15_000, costByCategory: { labor: 10_000, materials: 5_000 } });
    const parts = categoryResults([{ f, mix: mix({ labor: 0.5, materials: 0.5 }) }]);
    const labor = parts.find((p) => p.category === "labor")!;
    const materials = parts.find((p) => p.category === "materials")!;
    expect(labor.charged).toBe(10_000);
    expect(labor.cost).toBe(10_000);
    expect(labor.marginPct).toBe(0);
    expect(materials.marginPct).toBeCloseTo(0.5);
    expect(parts[0].category).toBe("labor"); // thinnest first
    expect(parts.reduce((s, p) => s + p.charged, 0)).toBeCloseTo(20_000);
    expect(parts.reduce((s, p) => s + p.cost, 0)).toBeCloseTo(15_000);
  });
});

describe("computeOpportunityFeed headline", () => {
  it("prices each finished job to target once, and ignores jobs above target", () => {
    const below = job({ revenue: 100_000, costs: 80_000 }); // needs 114,285.71
    const above = job({ revenue: 100_000, costs: 60_000 });
    const out = feed([below, above]);
    expect(out.summary.pricingGap).toBeCloseTo(80_000 / 0.7 - 100_000, 2);
    expect(out.summary.jobsBelowTarget).toBe(1);
    expect(out.summary.jobsJudged).toBe(2);
  });

  it("leaves out jobs finished more than a year ago, open jobs, and jobs without both revenue and costs", () => {
    const out = feed([
      job({ revenue: 100_000, costs: 90_000, lastFinancialActivity: daysAgo(400) }),
      job({ revenue: 100_000, costs: 90_000, status: "open" }),
      job({ revenue: 100_000, costs: 0 }),
    ]);
    expect(out.summary.pricingGap).toBe(0);
    expect(out.finishedJobsConsidered).toBe(0);
  });

  it("switches off without a target and says so", () => {
    const out = feed([job({ revenue: 100, costs: 90, targetMarginPct: null })]);
    expect(out.summary.targetSet).toBe(false);
    expect(out.setup.map((s) => s.code)).toContain("no_target");
    expect(out.summary.pricingGap).toBe(0);
  });
});

describe("job type pricing", () => {
  const remodels = () => [
    job({ category: "remodel", revenue: 50_000, costs: 42_000 }),
    job({ category: "remodel", revenue: 40_000, costs: 33_000 }),
    job({ category: "remodel", revenue: 30_000, costs: 24_000 }),
  ];

  it("flags a job type below target with the profit a price at target adds", () => {
    const jobs = remodels();
    const out = feed(jobs);
    const item = out.items.find((i) => i.id === "job_type_pricing:remodel")!;
    expect(item).toBeDefined();
    // 99,000 cost / 0.7 = 141,428.57 against 120,000 of revenue.
    expect(item.impact).toBeCloseTo(99_000 / 0.7 - 120_000, 2);
    // Margin 17.5%; (1 - .175) / (1 - .3) - 1 = 17.86%, rounded up.
    expect(item.action).toContain("about 18%");
    expect(item.trackable).toMatchObject({ kind: "job_type", subjectKey: "remodel", baselineJobs: 3 });
    expect(item.trackable!.baselineMarginPct).toBeCloseTo(0.175);
    expect(item.jobIds).toHaveLength(3);
  });

  it("needs three jobs of the type", () => {
    const out = feed(remodels().slice(0, 2));
    expect(out.items.find((i) => i.kind === "job_type_pricing")).toBeUndefined();
  });

  it("names the thin part of the price when the estimates split it", () => {
    const jobs = [
      job({ category: "remodel", revenue: 40_000, costs: 32_000, costByCategory: { labor: 19_000, materials: 13_000 } }),
      job({ category: "remodel", revenue: 40_000, costs: 32_000, costByCategory: { labor: 19_000, materials: 13_000 } }),
      job({ category: "remodel", revenue: 40_000, costs: 32_000, costByCategory: { labor: 19_000, materials: 13_000 } }),
    ];
    const mixes = new Map(jobs.map((j) => [j.jobId, mix({ labor: 0.5, materials: 0.5 })]));
    const item = feed(jobs, { mixes }).items.find((i) => i.kind === "job_type_pricing")!;
    // Labor: charged 60,000, cost 57,000 (5%). Materials: 60,000 vs 39,000 (35%).
    expect(item.cause).toContain("The thin part is labor");
    expect(item.cause).toContain("margin of 5.0%");
    expect(item.trackable!.costCategory).toBe("labor");
    expect(item.trackable!.baselineMarginPct).toBeCloseTo(0.05);
    expect(item.breakdown!.map((b) => b.category)).toEqual(["labor", "materials"]);
    // Whole gap on labor alone: gap/revenue = 14.29%, over a 50% share = 28.6% -> 29%.
    expect(item.action).toContain("labor line on your remodel estimates by about 29%");
  });

  it("gives a cost-overrun cause from real estimates, not ones filled from the target", () => {
    const mk = () =>
      job({ category: "remodel", revenue: 40_000, costs: 32_000, estimatedCost: 28_000, varianceVsEstimate: 4_000, varianceVsEstimatePct: 4_000 / 28_000 });
    const jobs = [mk(), mk(), mk()];
    expect(feed(jobs).items[0].cause).toContain("over estimate");
    const filled = new Set(jobs.map((j) => j.jobId));
    expect(feed(jobs, { targetFilledEstimates: filled }).items[0].cause).toBeNull();
  });

  it("calls out work that's clearly paying", () => {
    const jobs = [
      ...[1, 2, 3].map(() => job({ category: "painting", revenue: 10_000, costs: 5_000 })),
      ...[1, 2, 3].map(() => job({ category: "roofing", revenue: 10_000, costs: 7_500 })),
    ];
    const strong = feed(jobs).items.find((i) => i.kind === "strong_job_type");
    expect(strong?.id).toBe("strong_job_type:painting");
    expect(strong?.section).toBe("working");
    expect(strong?.impact).toBeNull();
  });
});

describe("lenses overlap, totals don't", () => {
  it("keeps the headline per job even when a job sits under a type and a customer", () => {
    const jobs = [1, 2, 3].map(() => job({ category: "remodel", customerName: "Acme", revenue: 10_000, costs: 9_000 }));
    jobs.push(job({ category: "remodel", customerName: "Other", revenue: 10_000, costs: 9_000 }));
    jobs.push(job({ category: "roofing", customerName: "Third", revenue: 10_000, costs: 6_000 }));
    const out = feed(jobs);
    const typeItem = out.items.find((i) => i.kind === "job_type_pricing")!;
    const customerItem = out.items.find((i) => i.kind === "customer_pricing")!;
    expect(typeItem.impact).toBeCloseTo(4 * (9_000 / 0.7 - 10_000), 2);
    expect(customerItem.impact).toBeCloseTo(3 * (9_000 / 0.7 - 10_000), 2);
    // Four jobs below target, each counted once, not seven.
    expect(out.summary.pricingGap).toBeCloseTo(4 * (9_000 / 0.7 - 10_000), 2);
    expect(customerItem.action).toContain("Price Acme's next job");
  });

  it("says a customer's pricing once when their jobs are exactly one job type", () => {
    const jobs = [1, 2, 3].map(() => job({ category: "general", customerName: "Brightline Builders", revenue: 10_000, costs: 9_000 }));
    jobs.push(job({ category: "roofing", customerName: "Other", revenue: 10_000, costs: 6_000 }));
    const out = feed(jobs);
    expect(out.items.filter((i) => i.kind === "job_type_pricing")).toHaveLength(0);
    expect(out.items.find((i) => i.kind === "customer_pricing")?.action).toContain("Brightline Builders' next job");
  });

  it("skips the customer lens when every job is its own customer", () => {
    const jobs = [1, 2, 3].map(() => job({ customerName: "Acme", revenue: 10_000, costs: 9_000 }));
    jobs.push(job({ customerName: "Other", revenue: 10_000, costs: 6_000 }));
    expect(feed(jobs).items.some((i) => i.kind === "customer_pricing")).toBe(true);
    expect(feed(jobs, { jobsAreCustomers: true }).items.some((i) => i.kind === "customer_pricing")).toBe(false);
  });
});

describe("small jobs", () => {
  it("flags the smallest third when it earns far less than bigger work", () => {
    const small = [3000, 3500, 4000].map((r) => job({ revenue: r, costs: r * 0.9 }));
    const big = [20_000, 25_000, 30_000, 35_000, 40_000, 45_000].map((r) => job({ revenue: r, costs: r * 0.65 }));
    const item = feed([...small, ...big]).items.find((i) => i.kind === "small_jobs")!;
    expect(item.title).toBe("Jobs of $4,000 or less don't pay");
    expect(item.jobIds).toHaveLength(3);
    expect(item.impact).toBeCloseTo((3000 + 3500 + 4000) * 0.9 / 0.7 - 10_500, 2);
    expect(item.trackable).toMatchObject({ kind: "small_jobs", subjectKey: "4000" });
  });

  it("rounds thresholds to figures people use", () => {
    expect(niceCeil(3_910)).toBe(4_000);
    expect(niceCeil(12_100)).toBe(13_000);
    expect(niceCeil(61_000)).toBe(65_000);
  });
});

describe("open jobs and cash", () => {
  it("uses the forecast where there is one, and spend past estimate where there isn't", () => {
    const withForecast = job({ status: "open", revenue: 20_000, costs: 30_000, estimatedRevenue: 60_000 });
    const noForecast = job({ status: "open", revenue: 10_000, costs: 23_000, estimatedCost: 20_000, varianceVsEstimate: 3_000, varianceVsEstimatePct: 0.15 });
    const forecasts = new Map<string, ForecastResult>([
      [withForecast.jobId, { available: true, forecastMarginPct: 0.2, forecastCostAtCompletion: 48_000, forecastProfit: 12_000, confidence: "medium", method: "m" }],
    ]);
    const out = feed([withForecast, noForecast], { forecasts });
    const fc = out.items.find((i) => i.kind === "open_job_forecast")!;
    expect(fc.impact).toBeCloseTo(60_000 * 0.1);
    const over = out.items.find((i) => i.kind === "open_job_over_estimate")!;
    expect(over.impact).toBe(3_000);
    expect(out.summary.openJobRisk).toBeCloseTo(9_000);
    expect(out.summary.openJobsAtRisk).toBe(2);
    expect(out.items[0].section).toBe("act_now");
  });

  it("keeps unbilled work out of profit figures", () => {
    const f = job({
      status: "open",
      revenue: 10_000,
      costs: 20_000,
      estimatedRevenue: 50_000,
      estimatedCost: 35_000,
      wip: { percentComplete: 0.6, percentCompleteSource: "cost", earnedRevenue: 30_000, overUnderBilling: -20_000, costPastEstimate: false },
    });
    const out = feed([f]);
    const item = out.items.find((i) => i.kind === "underbilled")!;
    expect(item.impactKind).toBe("cash");
    expect(out.summary.unbilledWork).toBe(20_000);
    expect(out.summary.openJobRisk).toBe(0);
  });
});

describe("computeEstimateCheck", () => {
  const history = () =>
    [1, 2, 3].map(() => ({
      f: job({ category: "remodel", revenue: 10_000, costs: 8_000, costByCategory: { labor: 5_000, materials: 3_000 } }),
      mix: mix({ labor: 0.5, materials: 0.5 }),
    }));

  it("costs the whole price at past jobs' rate when the estimate isn't split", () => {
    const r = computeEstimateCheck({ amount: 10_000, lines: [], targetPct: 30, history: history(), now: NOW });
    expect(r.method).toBe("whole_job");
    expect(r.expectedCost).toBeCloseTo(8_000);
    expect(r.expectedMarginPct).toBeCloseTo(0.2);
    expect(r.priceAtTarget).toBeCloseTo(8_000 / 0.7);
    expect(r.shortfall).toBeCloseTo(8_000 / 0.7 - 10_000);
    expect(r.status).toBe("below_target");
  });

  it("costs each part at its own rate when both sides are split", () => {
    // Past labor cost 1.0 per dollar charged, materials 0.6.
    const lines = [
      { n: "Labor", c: "labor" as const, a: 3_000 },
      { n: "Materials", c: "materials" as const, a: 7_000 },
    ];
    const r = computeEstimateCheck({ amount: 10_000, lines, targetPct: 30, history: history(), now: NOW });
    expect(r.method).toBe("by_part");
    expect(r.expectedCost).toBeCloseTo(3_000 * 1.0 + 7_000 * 0.6);
    // 1 - 7,200 / 10,000 = 28%, below 30%.
    expect(r.status).toBe("below_target");
    expect(r.shortfall).toBeCloseTo(7_200 / 0.7 - 10_000);
    expect(r.parts.map((p) => [p.category, Math.round(p.costRatio * 100)])).toEqual([["labor", 100], ["materials", 60]]);
    // Split the other way, the same total is further below: labor is where past jobs ran thin.
    const heavyLabor = [
      { n: "Labor", c: "labor" as const, a: 7_000 },
      { n: "Materials", c: "materials" as const, a: 3_000 },
    ];
    expect(computeEstimateCheck({ amount: 10_000, lines: heavyLabor, targetPct: 30, history: history(), now: NOW }).status).toBe("below_target");
  });

  it("refuses to guess without three comparable finished jobs or a target", () => {
    expect(computeEstimateCheck({ amount: 5_000, lines: [], targetPct: 30, history: history().slice(0, 2), now: NOW }).status).toBe("no_history");
    expect(computeEstimateCheck({ amount: 5_000, lines: [], targetPct: null, history: history(), now: NOW }).status).toBe("no_target");
    const old = history().map((h) => ({ ...h, f: { ...h.f, lastFinancialActivity: daysAgo(800) } }));
    expect(computeEstimateCheck({ amount: 5_000, lines: [], targetPct: 30, history: old, now: NOW }).status).toBe("no_history");
  });

  it("marks the check low confidence when past jobs disagree", () => {
    const h = [
      { f: job({ revenue: 10_000, costs: 4_000 }), mix: null },
      { f: job({ revenue: 10_000, costs: 9_500 }), mix: null },
      { f: job({ revenue: 10_000, costs: 7_000 }), mix: null },
    ];
    expect(computeEstimateCheck({ amount: 10_000, lines: [], targetPct: 30, history: h, now: NOW }).confidence).toBe("low");
  });
});

describe("computeActionOutcome", () => {
  const started = daysAgo(90);
  const action = { kind: "job_type" as const, subjectKey: "remodel", costCategory: null, baselineMarginPct: 0.18, baselineJobs: 5, startedAt: started };

  it("waits until a job priced after the change finishes", () => {
    const out = computeActionOutcome(action, [
      job({ category: "remodel", revenue: 10_000, costs: 7_000, qboCreatedAt: daysAgo(200) }), // before
      job({ category: "remodel", status: "open", revenue: 1_000, costs: 500, qboCreatedAt: daysAgo(30) }),
    ], new Map());
    expect(out.status).toBe("waiting");
    expect(out.inProgress).toBe(1);
  });

  it("measures finished jobs created after the change against the baseline", () => {
    const out = computeActionOutcome(action, [
      job({ category: "remodel", revenue: 10_000, costs: 7_000, qboCreatedAt: daysAgo(60) }),
      job({ category: "remodel", revenue: 30_000, costs: 21_000, qboCreatedAt: daysAgo(40) }),
      job({ category: "roofing", revenue: 30_000, costs: 29_000, qboCreatedAt: daysAgo(40) }),
    ], new Map());
    expect(out.status).toBe("measured");
    expect(out.afterJobs).toBe(2);
    expect(out.afterMarginPct).toBeCloseTo(0.3);
    expect(out.extraProfit).toBeCloseTo(40_000 * (0.3 - 0.18));
    expect(out.message).toContain("Early days");
  });

  it("measures one part of the price for a part-of-the-price change", () => {
    const a = { ...action, costCategory: "labor" as const, baselineMarginPct: 0.05 };
    const f = job({ category: "remodel", revenue: 20_000, costs: 14_000, costByCategory: { labor: 8_000, materials: 6_000 }, qboCreatedAt: daysAgo(10) });
    const out = computeActionOutcome(a, [f], new Map([[f.jobId, mix({ labor: 0.5, materials: 0.5 })]]));
    expect(out.afterMarginPct).toBeCloseTo(0.2); // labor: charged 10,000, cost 8,000
  });
});


describe("review fixes", () => {
  it("leaves a job out of by-part figures when a part that cost money was never priced", () => {
    // Estimates list labor and materials; subs are paid by bill.
    const jobs = [1, 2, 3, 4].map(() =>
      job({ category: "remodel", revenue: 100_000, costs: 90_000, costByCategory: { labor: 35_000, materials: 25_000, subcontractor: 30_000 } })
    );
    const history = jobs.map((f) => ({ f, mix: mix({ labor: 0.5, materials: 0.5 }) }));
    expect(categoryResults(history)).toEqual([]);
    const r = computeEstimateCheck({
      amount: 100_000,
      lines: [{ n: "Labor", c: "labor", a: 50_000 }, { n: "Materials", c: "materials", a: 50_000 }],
      targetPct: 28,
      history,
      now: NOW,
    });
    expect(r.method).toBe("whole_job");
    expect(r.expectedMarginPct).toBeCloseTo(0.1);
    expect(r.status).toBe("below_target");
  });

  it("falls back to the whole price when the estimate leaves out a part past jobs spent on", () => {
    const history = [1, 2, 3].map(() => ({
      f: job({ revenue: 100_000, costs: 80_000, costByCategory: { labor: 30_000, materials: 20_000, subcontractor: 30_000 } }),
      mix: mix({ labor: 0.4, materials: 0.3, subcontractor: 0.3 }),
    }));
    const r = computeEstimateCheck({
      amount: 100_000,
      lines: [{ n: "Labor", c: "labor", a: 50_000 }, { n: "Materials", c: "materials", a: 50_000 }],
      targetPct: 28,
      history,
      now: NOW,
    });
    expect(r.method).toBe("whole_job");
    expect(r.confidenceReason).toContain("doesn't price subcontracted work separately");
  });

  it("never calls an estimate at or above a target it misses", () => {
    const history = [1, 2, 3].map(() => ({ f: job({ revenue: 10_000, costs: 7_280 }), mix: null }));
    const r = computeEstimateCheck({ amount: 10_000, lines: [], targetPct: 28, history, now: NOW });
    expect(r.expectedMarginPct).toBeCloseTo(0.272);
    expect(r.status).toBe("below_target");
    expect(r.summary).toContain("Reaching your 28% target");
  });

  it("prints a fractional target as set", () => {
    const jobs = [1, 2, 3].map(() => job({ category: "remodel", revenue: 10_000, costs: 8_000, targetMarginPct: 27.5 }));
    const item = feed(jobs).items.find((i) => i.kind === "job_type_pricing")!;
    expect(item.title).toContain("27.5% target");
    expect(item.action).toContain("27.5% target");
  });

  it("measures a mixed-target group against each job's own target, never more than the headline", () => {
    const jobs = [
      job({ customerName: "Acme", category: "kitchen", revenue: 50_000, costs: 50_000, targetMarginPct: 20 }),
      job({ customerName: "Acme", category: "roof", revenue: 100_000, costs: 60_000, targetMarginPct: 40 }),
      job({ customerName: "Acme", category: "roof", revenue: 100_000, costs: 60_000, targetMarginPct: 40 }),
      job({ customerName: "Other", category: "roof", revenue: 100_000, costs: 60_000, targetMarginPct: 40 }),
    ];
    const out = feed(jobs);
    const acme = out.items.find((i) => i.kind === "customer_pricing")!;
    expect(out.summary.pricingGap).toBeCloseTo(12_500);
    expect(acme.impact).toBeCloseTo(12_500);
    expect(acme.title).toBe("Work for Acme runs below your targets");
  });

  it("ignores a job whose costs are all booked to one part of a split price", () => {
    const f = job({ revenue: 10_000, costs: 8_000, costByCategory: { materials: 8_000 } });
    expect(categoryResults([{ f, mix: mix({ labor: 0.5, materials: 0.5 }) }])).toEqual([]);
  });

  it("groups small jobs at the threshold it names", () => {
    const revs = [1000, 1100, 1600, 2600, 2700, 9000, 9500, 10000, 12000];
    const jobs = revs.map((r) => job({ revenue: r, costs: r < 5000 ? r * 0.95 : r * 0.6 }));
    const item = feed(jobs).items.find((i) => i.kind === "small_jobs")!;
    expect(item.title).toBe("Jobs of $1,750 or less don't pay");
    expect(item.jobIds).toHaveLength(3);
    expect(item.finding).toContain("3 finished jobs of $1,750 or less");
    // When the cut would sweep in most of the jobs, there's no small-jobs finding at all.
    const crowded = [1000, 1100, 1600, 1700, 1740, 9000, 9500, 10000, 12000].map((r) => job({ revenue: r, costs: r < 5000 ? r * 0.95 : r * 0.6 }));
    expect(feed(crowded).items.some((i) => i.kind === "small_jobs")).toBe(false);
  });

  it("says why a part-of-the-price change can't be measured yet", () => {
    const a = { kind: "job_type" as const, subjectKey: "remodel", costCategory: "labor" as const, baselineMarginPct: 0.05, baselineJobs: 4, startedAt: daysAgo(90) };
    const out = computeActionOutcome(a, [1, 2, 3].map(() => job({ category: "remodel", revenue: 10_000, costs: 7_000, qboCreatedAt: daysAgo(30) })), new Map());
    expect(out.status).toBe("waiting");
    expect(out.message).toContain("can't be measured");
  });

  it("writes job types and parts so they read as English", () => {
    const hvac = [1, 2, 3].map(() => job({ category: "hvac", revenue: 10_000, costs: 9_000 }));
    const other = [1, 2, 3].map(() => job({ category: "other", revenue: 10_000, costs: 9_000 }));
    const labels = (k: string) => ({ hvac: "HVAC", other: "Other" })[k] ?? k;
    const items = feed([...hvac, ...other], { typeLabel: labels }).items;
    expect(items.find((i) => i.id === "job_type_pricing:hvac")!.title).toBe("HVAC jobs are priced below your 30% target");
    expect(items.find((i) => i.id === "job_type_pricing:other")!.title).toBe("\u201cOther\u201d jobs are priced below your 30% target");
    expect(items.find((i) => i.id === "job_type_pricing:hvac")!.finding).toContain("finished HVAC jobs");
  });

  it("counts a credit line against its own part of the price", () => {
    const m = pricedMixFromLines([
      { n: "Labor", c: "labor", a: 10_000 },
      { n: "Materials", c: "materials", a: 10_000 },
      { n: "Labor credit", c: "labor", a: -4_000 },
    ])!;
    expect(m.shares.labor).toBeCloseTo(6 / 16);
  });
});


describe("second review fixes", () => {
  it("keeps small unpriced parts' costs in the priced parts, so the check can't look healthier than the jobs were", () => {
    const history = [1, 2, 3].map(() => ({
      f: job({ category: "remodel", revenue: 100_000, costs: 80_000, costByCategory: { labor: 36_000, materials: 36_160, equipment: 3_920, subcontractor: 3_920 } }),
      mix: mix({ labor: 0.5, materials: 0.5 }),
    }));
    const parts = categoryResults(history);
    expect(parts.reduce((s, p) => s + p.cost, 0)).toBeCloseTo(240_000, 2);
    const r = computeEstimateCheck({
      amount: 100_000,
      lines: [{ n: "Labor", c: "labor", a: 50_000 }, { n: "Materials", c: "materials", a: 50_000 }],
      targetPct: 25,
      history,
      now: NOW,
    });
    expect(r.expectedMarginPct).toBeCloseTo(0.2, 6);
    expect(r.status).toBe("below_target");
  });

  it("calls a small estimate below target whenever its margin is", () => {
    const history = [1, 2, 3].map(() => ({ f: job({ revenue: 10_000, costs: 7_207 }), mix: null }));
    const r = computeEstimateCheck({ amount: 500, lines: [], targetPct: 28, history, now: NOW });
    expect(r.status).toBe("below_target");
    expect(r.summary).not.toContain("at or above");
  });

  it("prints targets exactly, to the cent of a percent", () => {
    expect(fmtTarget(0.2755)).toBe("27.55%");
    expect(fmtTarget(0.2804)).toBe("28.04%");
    expect(fmtTarget(0.28)).toBe("28%");
    expect(fmtTarget(0.275)).toBe("27.5%");
  });

  it("counts finished jobs it couldn't measure, the same in numbers and words", () => {
    const a = { kind: "job_type" as const, subjectKey: "remodel", costCategory: "labor" as const, baselineMarginPct: 0.05, baselineJobs: 4, startedAt: daysAgo(90) };
    const out = computeActionOutcome(a, [1, 2].map(() => job({ category: "remodel", revenue: 10_000, costs: 7_000, qboCreatedAt: daysAgo(30) })), new Map());
    expect(out.afterJobs).toBe(2);
    expect(out.message).toContain("2 jobs set up since then have finished");
  });

  it("explains a target over the cap instead of just asking for one", () => {
    const out = feed([job({ revenue: 100, costs: 90, targetMarginPct: 95 })]);
    expect(out.summary.targetSet).toBe(false);
    expect(out.setup.find((h) => h.code === "no_target")?.message).toContain("above 90%");
  });
});
