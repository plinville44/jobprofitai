import { describe, it, expect } from "vitest";
import type { JobFinancials } from "../profitability";
import {
  computeActionOutcome,
  computeEstimateCheck,
  computeOpportunityFeed,
  costFromQuantities,
  QUANTITY_CROSS_CHECK_GAP,
} from "../opportunities";
import type { EstimateLine } from "../qboNormalize";

const NOW = new Date("2026-09-28T12:00:00Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000);

let seq = 0;
function job(p: Partial<JobFinancials> & { revenue: number; costs: number }): JobFinancials {
  seq++;
  const { revenue, costs } = p;
  const available = revenue > 0 && costs > 0;
  return {
    jobId: p.jobId ?? `j${seq}`,
    jobName: p.jobName ?? `Job ${seq}`,
    customerName: p.customerName ?? `Customer ${seq}`,
    status: p.status ?? "closed",
    category: p.category ?? null,
    revenue,
    estimatedRevenue: null,
    costs,
    estimatedCost: null,
    costByCategory: p.costByCategory ?? { materials: costs },
    profitabilityAvailable: available,
    unavailableReason: null,
    grossProfit: available ? revenue - costs : null,
    grossMarginPct: available ? (revenue - costs) / revenue : null,
    fullyLoadedProfit: null,
    fullyLoadedMarginPct: null,
    targetMarginPct: 25,
    varianceVsEstimate: null,
    varianceVsEstimatePct: null,
    dataConfidence: "high",
    confidenceReasons: [],
    lastFinancialActivity: p.lastFinancialActivity === undefined ? daysAgo(60) : p.lastFinancialActivity,
    qboCreatedAt: p.qboCreatedAt ?? daysAgo(200),
    wip: null,
    flags: [],
  };
}

/** Three finished roofing jobs that came in at 18%. */
const roofingAt18 = () => [1, 2, 3].map(() => ({ f: job({ category: "roofing", revenue: 10_000, costs: 8_200 }), mix: null }));

describe("Estimate Check: quantities checked against past jobs", () => {
  it("doesn't call an installed price costed at a materials-only item cost on target (the reviewer's roofing run)", () => {
    // "Shingles installed", 30 at $450 against a $110 materials-only item cost.
    const lines: EstimateLine[] = [{ n: "Shingles installed", c: "materials", a: 13_500, q: 30, u: 110, qa: 13_500 }];
    const r = computeEstimateCheck({ amount: 13_500, lines, targetPct: 25, history: roofingAt18(), now: NOW, typeLabel: "Roofing" });
    expect(r.quantityMarginOverruled).toBeCloseTo(1 - 3_300 / 13_500);
    // Judged on the lower figure: the past jobs' 18%, below the 25% target.
    expect(r.expectedMarginPct).toBeCloseTo(0.18);
    expect(r.status).toBe("below_target");
    expect(r.shortfall).toBeCloseTo((13_500 * 0.82) / 0.75 - 13_500);
    expect(r.confidence).toBe("low");
    expect(r.method).toBe("whole_job");
    expect(r.summary).toContain("Costed from its quantities this comes to 75.6%, but your past roofing jobs came in at 18.0%");
    expect(r.summary).toContain("Check that labor and installation are on the estimate");
    expect(r.confidenceReason).toContain("judged on the lower figure");
    // The line table still shows how the line was read, so the misreading is visible.
    expect(r.lineReadings).toHaveLength(1);
    expect(r.lineReadings[0].reading).toContain("Read as 30 units at the item cost of $110 a unit, charged at $450 a unit.");
    expect(r.lineReadings[0].reading).toContain("4.1 times the item cost: if it's sold installed");
    expect(r.quantityLines).toHaveLength(1);
  });

  it("overrules labor priced per square read as hours", () => {
    // Roofing labor at $90 a square, 30 squares, read as 30 hours.
    const rate = { perHour: 1_720 / 30, hours: 2_000, burden: 0 };
    const lines: EstimateLine[] = [{ n: "Roofing labor", c: "labor", a: 2_700, q: 30, qa: 2_700 }];
    const r = computeEstimateCheck({ amount: 2_700, lines, targetPct: 25, history: roofingAt18(), now: NOW, laborRate: rate, typeLabel: "Roofing" });
    expect(r.quantityMarginOverruled).toBeCloseTo(0.363, 3);
    expect(r.expectedMarginPct).toBeCloseTo(0.18);
    expect(r.status).toBe("below_target");
    expect(r.lineReadings[0].reading).toBe("Read as 30 hours at your labor cost of $57.33 an hour, charged at $90 an hour.");
  });

  it("keeps the quantity result when it's within the gap of past jobs, and names the job type", () => {
    // Past jobs at 40%, quantities at 50%: 10 points apart.
    const history = [1, 2, 3].map(() => ({ f: job({ category: "roofing", revenue: 10_000, costs: 6_000 }), mix: null }));
    const lines: EstimateLine[] = [{ n: "Shingles", c: "materials", a: 10_000, q: 50, u: 100, qa: 10_000 }];
    const r = computeEstimateCheck({ amount: 10_000, lines, targetPct: 25, history, now: NOW, typeLabel: "Roofing" });
    expect(0.5 - 0.4).toBeLessThan(QUANTITY_CROSS_CHECK_GAP);
    expect(r.method).toBe("quantities");
    expect(r.quantityMarginOverruled).toBeNull();
    expect(r.expectedMarginPct).toBeCloseTo(0.5);
    expect(r.confidence).toBe("medium");
    expect(r.summary).toContain("Your past roofing jobs came in at 40.0%.");
    expect(r.lineReadings).toHaveLength(1);
  });

  it("can't cross-check with fewer than three past jobs, but still shows each line's reading", () => {
    const lines: EstimateLine[] = [{ n: "Shingles installed", c: "materials", a: 13_500, q: 30, u: 110, qa: 13_500 }];
    const r = computeEstimateCheck({ amount: 13_500, lines, targetPct: 25, history: roofingAt18().slice(0, 2), now: NOW, typeLabel: "Roofing" });
    expect(r.method).toBe("quantities");
    expect(r.status).toBe("on_target");
    expect(r.quantityMarginOverruled).toBeNull();
    expect(r.lineReadings[0].reading).toContain("sold installed");
  });

  it("uses the lower figure on a partly costed estimate too", () => {
    const history = roofingAt18();
    const lines: EstimateLine[] = [
      { n: "Shingles installed", c: "materials", a: 9_000, q: 20, u: 110, qa: 9_000 },
      { n: "Permit", c: "other", a: 1_000 },
    ];
    const r = computeEstimateCheck({ amount: 10_000, lines, targetPct: 25, history, now: NOW, typeLabel: "Roofing" });
    // Quantities: 2,200 + 1,000 x 0.82 = 3,020 of cost, 69.8%; past jobs 18%.
    expect(r.quantityMarginOverruled).toBeCloseTo(1 - 3_020 / 10_000);
    expect(r.expectedMarginPct).toBeCloseTo(0.18);
    expect(r.lineReadings.map((l) => l.cost)).toEqual([2_200, null]);
  });

  it("flags an overruled estimate in the feed and says the quantities were set aside", () => {
    const lines: EstimateLine[] = [{ n: "Shingles installed", c: "materials", a: 13_500, q: 30, u: 110, qa: 13_500 }];
    const r = computeEstimateCheck({ amount: 13_500, lines, targetPct: 25, history: roofingAt18(), now: NOW, typeLabel: "Roofing" });
    const feed = computeOpportunityFeed({
      now: NOW,
      jobs: [],
      forecasts: new Map(),
      mixes: new Map(),
      typeLabel: (k) => k,
      estimateFlags: [
        {
          estimateId: "e1",
          label: "Estimate 1001",
          shortfall: r.shortfall ?? 0,
          predictedMarginPct: r.expectedMarginPct ?? 0,
          targetMarginPct: r.targetMarginPct ?? 0,
          confidence: r.confidence,
          confidenceReason: r.confidenceReason,
          notEmailed: false,
          typeLabel: "Roofing",
          historyJobs: r.historyJobs,
          method: r.method,
          quantityMarginOverruled: r.quantityMarginOverruled,
        },
      ],
    });
    const item = feed.items.find((i) => i.kind === "estimate_below_target")!;
    expect(item.finding).toContain("it earns 18.0% against your 25% target");
    expect(item.cause).toContain("Costed from its quantities it would earn 75.6%, far more than your roofing jobs have");
    expect(item.confidence).toBe("low");
  });

  it("doesn't overrule quantities that come out below past jobs", () => {
    const history = [1, 2, 3].map(() => ({ f: job({ category: "roofing", revenue: 10_000, costs: 5_000 }), mix: null }));
    const lines: EstimateLine[] = [{ n: "Shingles", c: "materials", a: 10_000, q: 80, u: 100, qa: 10_000 }];
    const r = computeEstimateCheck({ amount: 10_000, lines, targetPct: 25, history, now: NOW });
    expect(r.method).toBe("quantities");
    expect(r.expectedMarginPct).toBeCloseTo(0.2);
    expect(r.status).toBe("below_target");
    expect(r.summary).toContain("Your past jobs of this type came in at 50.0%.");
  });
});

describe("Estimate Check: how each line was read", () => {
  const rate = { perHour: 40, hours: 2_000, burden: 0.2 };

  it("says why a line wasn't costed", () => {
    const qc = costFromQuantities(
      [
        { n: "Demo", c: "labor", a: 4_000, q: 1 }, // stored before per-line judging: a lump sum
        { n: "Permit", c: "other", a: 500 },
        { n: null, c: "other", a: 200 },
        { n: "Labor", c: "labor", a: 3_000, q: null, qa: null }, // judged at sync: not hours
        { n: "Service call", c: "labor", a: 4_000, q: null, u: 35, qa: null },
        { n: "Discount", c: "materials", a: -100 },
      ],
      rate
    );
    expect(qc.lines).toHaveLength(0);
    expect(qc.readings.map((r) => r.reading)).toEqual([
      "Not costed: priced as a lump sum ($4,000 for 1), not per hour.",
      "Not costed: no purchase cost is set on this product or service in QuickBooks.",
      "Not costed: no product or service on the line to take a cost from.",
      "Not costed: no hours, or not priced at an hourly rate ($15 to $300 an hour), so it's read as a lump sum.",
      "Not costed: no quantity, or priced far from the item cost of $35 a unit, so it's read as a lump sum.",
      "Not costed: a credit or discount, not a charge.",
    ]);
    expect(qc.readings.every((r) => r.cost == null && r.costedPrice === 0)).toBe(true);
  });

  it("says when hours can't be costed for want of a labor rate", () => {
    const qc = costFromQuantities([{ n: "Framing labor", c: "labor", a: 3_600, q: 40, qa: 3_600 }], null);
    expect(qc.readings[0].reading).toContain("no average labor cost per hour");
  });

  it("shows the part of a merged line priced as a lump sum", () => {
    const qc = costFromQuantities([{ n: "Labor", c: "labor", a: 7_200, q: 40, qa: 3_200 }], rate);
    expect(qc.readings[0]).toMatchObject({ price: 7_200, costedPrice: 3_200, cost: 1_600, basis: "labor_rate" });
    expect(qc.readings[0].reading).toBe(
      "Read as 40 hours at your labor cost of $40 an hour, charged at $80 an hour. The other $4,000 on this line is priced as a lump sum and isn't costed."
    );
  });

  it("keeps cents on small unit costs", () => {
    const qc = costFromQuantities([{ n: "Screws", c: "materials", a: 90, q: 100, u: 0.45, qa: 90 }], null);
    expect(qc.readings[0].reading).toBe("Read as 100 units at the item cost of $0.45 a unit, charged at $0.90 a unit.");
  });
});

describe("Estimate Check: labor items at their purchase cost", () => {
  const tile: EstimateLine[] = [{ n: "Tile setter", c: "labor", a: 1_200, q: 20, u: 30, qa: 1_200 }];

  it("labels a labor item with the burden added as item cost plus burden", () => {
    const qc = costFromQuantities(tile, null, 0.2);
    expect(qc.lines[0]).toMatchObject({ itemCost: 30, burdenAdded: 0.2, unitCost: 36, cost: 720 });
    expect(qc.readings[0].reading).toBe(
      "Read as 20 units at the item cost of $30 plus your 20% labor burden (item cost plus burden, $36 a unit), charged at $60 a unit."
    );
  });

  it("adds no burden when there's none to add (time-entry labor off passes 0)", () => {
    const qc = costFromQuantities(tile, null, 0);
    expect(qc.lines[0]).toMatchObject({ itemCost: 30, burdenAdded: 0, unitCost: 30, cost: 600 });
    expect(qc.readings[0].reading).toBe("Read as 20 units at the item cost of $30 a unit, charged at $60 a unit.");
    expect(qc.readings[0].reading).not.toContain("burden");
    const r = computeEstimateCheck({ amount: 1_200, lines: tile, targetPct: 25, history: [], now: NOW, laborRate: null, laborBurden: 0 });
    expect(r.expectedCost).toBeCloseTo(600);
    expect(r.methodNote).not.toContain("burden");
  });

  it("never adds the burden to materials items", () => {
    const qc = costFromQuantities([{ n: "Tile", c: "materials", a: 1_000, q: 100, u: 5, qa: 1_000 }], null, 0.3);
    expect(qc.lines[0]).toMatchObject({ burdenAdded: 0, unitCost: 5, cost: 500 });
  });
});

describe("tracked changes after the basis changed", () => {
  const started = daysAgo(120);
  const action = { kind: "job_type" as const, subjectKey: "remodel", costCategory: null, baselineMarginPct: 0.2, baselineJobs: 5, startedAt: started };
  // The reviewer's run: baseline 20% at a 30% burden, burden then set to 0,
  // and the jobs since come in at 29.2%.
  const since = () => [1, 2, 3].map(() => job({ category: "remodel", revenue: 10_000, costs: 7_080, qboCreatedAt: daysAgo(90) }));

  it("shows no gain or loss when the labor burden changed after tracking started", () => {
    const out = computeActionOutcome(action, since(), new Map(), { laborBurdenSetAt: daysAgo(30) });
    expect(out.status).toBe("measured");
    expect(out.afterMarginPct).toBeCloseTo(0.292);
    expect(out.extraProfit).toBeNull();
    expect(out.basisChanged).toBe("labor_burden");
    expect(out.confidence).toBe("low");
    expect(out.message).toContain("earned 29.2%.");
    expect(out.message).toContain("labor was costed one way for the 20.0% before and another way for jobs today");
    expect(out.message).toContain("can't be compared, so no gain or loss is shown");
    expect(out.message).not.toContain("more gross profit");
  });

  it("measures as usual when the burden changed before tracking started", () => {
    const out = computeActionOutcome(action, since(), new Map(), { laborBurdenSetAt: daysAgo(200), basisChangedAt: daysAgo(150) });
    expect(out.basisChanged).toBeNull();
    expect(out.extraProfit).toBeCloseTo(30_000 * (0.292 - 0.2));
    expect(out.message).toContain("more gross profit");
  });

  it("measures as usual with no dates given", () => {
    expect(computeActionOutcome(action, since(), new Map()).basisChanged).toBeNull();
  });

  it("shows no gain or loss after job figures were rebuilt", () => {
    const out = computeActionOutcome(action, since(), new Map(), { basisChangedAt: daysAgo(10) });
    expect(out.basisChanged).toBe("job_figures");
    expect(out.extraProfit).toBeNull();
    expect(out.message).toContain("worked out again after this started");
  });

  it("ignores a burden change for a change to materials pricing, but not a rebuild", () => {
    const f = job({
      category: "remodel",
      revenue: 20_000,
      costs: 14_000,
      costByCategory: { labor: 8_000, materials: 6_000 },
      qboCreatedAt: daysAgo(60),
    });
    const mixes = new Map([[f.jobId, { shares: { labor: 0.5, materials: 0.5 }, coverage: 1, quoted: 1 }]]);
    const materials = { ...action, kind: "cost_category" as const, subjectKey: "all", costCategory: "materials" as const, baselineMarginPct: 0.3 };
    const burdenOnly = computeActionOutcome(materials, [f], mixes, { laborBurdenSetAt: daysAgo(30) });
    expect(burdenOnly.basisChanged).toBeNull();
    expect(burdenOnly.extraProfit).not.toBeNull();
    const rebuilt = computeActionOutcome(materials, [f], mixes, { basisChangedAt: daysAgo(30) });
    expect(rebuilt.basisChanged).toBe("job_figures");
    expect(rebuilt.extraProfit).toBeNull();
    const labor = computeActionOutcome({ ...materials, costCategory: "labor" }, [f], mixes, { laborBurdenSetAt: daysAgo(30) });
    expect(labor.basisChanged).toBe("labor_burden");
  });

  it("says too few jobs are left to rebuild the before figure when that's why nothing is compared", () => {
    const out = computeActionOutcome(action, since(), new Map(), { basisChangedAt: daysAgo(10) });
    expect(out.baselineRebuilt).toBe(false);
    expect(out.baselineMarginPct).toBe(0.2);
    expect(out.baselineJobs).toBe(5);
    expect(out.message).toContain("Too few of the jobs it was based on are left");
  });

  it("says so while still waiting for jobs to finish", () => {
    const open = job({ category: "remodel", status: "open", revenue: 1_000, costs: 500, qboCreatedAt: daysAgo(30) });
    const out = computeActionOutcome(action, [open], new Map(), { laborBurdenSetAt: daysAgo(10) });
    expect(out.status).toBe("waiting");
    expect(out.basisChanged).toBe("labor_burden");
    expect(out.message).toContain("still in progress");
    expect(out.message).toContain("can't be compared with the 20.0% before");
  });
});

describe("tracked changes: the before figure worked out again on today's figures", () => {
  const started = daysAgo(120);
  const action = { kind: "job_type" as const, subjectKey: "remodel", costCategory: null, baselineMarginPct: 0.2, baselineJobs: 3, startedAt: started };
  // The jobs the baseline was saved from: set up and finished before tracking
  // started. On today's figures (the burden now 0%) they come to 25%.
  const beforeJobs = () =>
    [1, 2, 3].map(() => job({ category: "remodel", revenue: 10_000, costs: 7_500, qboCreatedAt: daysAgo(400), lastFinancialActivity: daysAgo(150) }));
  // The jobs since, at 29.2%.
  const since = () => [1, 2, 3].map(() => job({ category: "remodel", revenue: 10_000, costs: 7_080, qboCreatedAt: daysAgo(90) }));

  it("measures against the rebuilt before figure when the labor burden changed (the reviewer's run)", () => {
    const out = computeActionOutcome(action, [...beforeJobs(), ...since()], new Map(), { laborBurdenSetAt: daysAgo(30) });
    expect(out.status).toBe("measured");
    expect(out.basisChanged).toBe("labor_burden");
    expect(out.baselineRebuilt).toBe(true);
    expect(out.baselineMarginPct).toBeCloseTo(0.25);
    expect(out.baselineJobs).toBe(3);
    // Against 25% on today's terms, not the 20% saved under the old burden.
    expect(out.extraProfit).toBeCloseTo(30_000 * (0.292 - 0.25));
    expect(out.message).toContain("earned 29.2%, against 25.0% before.");
    expect(out.message).toContain("worked out again with today's setting on the 3 jobs finished in the 12 months before you started tracking: 25.0%, where it read 20.0% on the day you started.");
    expect(out.message).not.toContain("can't be compared");
    expect(out.confidence).toBe("medium");
    expect(out.message).not.toMatch(/[\u2013\u2014]/);
  });

  it("does the same after a sync version upgrade changed the figures", () => {
    const out = computeActionOutcome(action, [...beforeJobs(), ...since()], new Map(), { basisChangedAt: daysAgo(10) });
    expect(out.basisChanged).toBe("job_figures");
    expect(out.baselineRebuilt).toBe(true);
    expect(out.extraProfit).toBeCloseTo(30_000 * (0.292 - 0.25));
    expect(out.message).toContain("Your job figures were worked out again after this started, so the before figure was too, from today's figures");
  });

  it("keeps the saved figure when nothing changed after tracking started", () => {
    const out = computeActionOutcome(action, [...beforeJobs(), ...since()], new Map(), { basisChangedAt: daysAgo(200) });
    expect(out.baselineRebuilt).toBe(false);
    expect(out.baselineMarginPct).toBe(0.2);
    expect(out.extraProfit).toBeCloseTo(30_000 * (0.292 - 0.2));
  });

  it("picks the jobs by the rule used on the day: finished in the 12 months before it, set up before it", () => {
    const others = [
      // Set up before, but with a cost after the start: may not have been finished then.
      job({ category: "remodel", revenue: 10_000, costs: 9_900, qboCreatedAt: daysAgo(300), lastFinancialActivity: daysAgo(100) }),
      // Finished more than 12 months before the start.
      job({ category: "remodel", revenue: 10_000, costs: 9_900, qboCreatedAt: daysAgo(700), lastFinancialActivity: daysAgo(500) }),
      // Another job type, and an open job.
      job({ category: "roofing", revenue: 10_000, costs: 9_900, qboCreatedAt: daysAgo(300), lastFinancialActivity: daysAgo(150) }),
      job({ category: "remodel", status: "open", revenue: 10_000, costs: 9_900, qboCreatedAt: daysAgo(300), lastFinancialActivity: daysAgo(150) }),
    ];
    const out = computeActionOutcome(action, [...beforeJobs(), ...others, ...since()], new Map(), { laborBurdenSetAt: daysAgo(30) });
    expect(out.baselineJobs).toBe(3);
    expect(out.baselineMarginPct).toBeCloseTo(0.25);
  });

  it("rebuilds a change to one part of the price from that part", () => {
    const withSplit = (costs: Record<string, number>, over: Partial<JobFinancials>) =>
      job({ category: "remodel", revenue: 20_000, costs: costs.labor + costs.materials, costByCategory: costs, ...over });
    const before = [1, 2, 3].map(() => withSplit({ labor: 8_000, materials: 6_000 }, { qboCreatedAt: daysAgo(400), lastFinancialActivity: daysAgo(150) }));
    const after = [1, 2, 3].map(() => withSplit({ labor: 7_000, materials: 6_000 }, { qboCreatedAt: daysAgo(90), lastFinancialActivity: daysAgo(20) }));
    const mixes = new Map([...before, ...after].map((f) => [f.jobId, { shares: { labor: 0.5, materials: 0.5 }, coverage: 1, quoted: 1 }]));
    const labor = { ...action, costCategory: "labor" as const, baselineMarginPct: 0.1 };
    const out = computeActionOutcome(labor, [...before, ...after], mixes, { laborBurdenSetAt: daysAgo(30) });
    expect(out.baselineRebuilt).toBe(true);
    // Labor charged $10,000 a job and cost $8,000 before; $7,000 since.
    expect(out.baselineMarginPct).toBeCloseTo(0.2);
    expect(out.afterMarginPct).toBeCloseTo(0.3);
    expect(out.extraProfit).toBeCloseTo(30_000 * 0.1);
  });

  it("rebuilds a small jobs change by the cost ceiling it was saved with", () => {
    const small = (costs: number, over: Partial<JobFinancials>) => job({ revenue: 3_000, costs, ...over });
    const before = [
      ...[1, 2, 3].map(() => small(2_700, { qboCreatedAt: daysAgo(400), lastFinancialActivity: daysAgo(150) })),
      // Too big to be one of the small jobs.
      job({ revenue: 40_000, costs: 30_000, qboCreatedAt: daysAgo(400), lastFinancialActivity: daysAgo(150) }),
    ];
    const after = [1, 2, 3].map(() => small(2_400, { qboCreatedAt: daysAgo(90) }));
    const smallJobs = { kind: "small_jobs" as const, subjectKey: "cost:2800", costCategory: null, baselineMarginPct: 0.05, baselineJobs: 3, startedAt: started };
    const out = computeActionOutcome(smallJobs, [...before, ...after], new Map(), { basisChangedAt: daysAgo(10) });
    expect(out.baselineJobs).toBe(3);
    expect(out.baselineMarginPct).toBeCloseTo(0.1);
    expect(out.afterMarginPct).toBeCloseTo(0.2);
  });

  it("shows the rebuilt before figure while waiting for jobs to finish", () => {
    const open = job({ category: "remodel", status: "open", revenue: 1_000, costs: 500, qboCreatedAt: daysAgo(30) });
    const out = computeActionOutcome(action, [...beforeJobs(), open], new Map(), { laborBurdenSetAt: daysAgo(10) });
    expect(out.status).toBe("waiting");
    expect(out.baselineRebuilt).toBe(true);
    expect(out.baselineMarginPct).toBeCloseTo(0.25);
    expect(out.message).toContain("still in progress");
    expect(out.message).toContain("where it read 20.0% on the day you started");
    expect(out.message).not.toContain("can't be compared");
  });
});

describe("Estimate Check: lines shown even when the past jobs decide", () => {
  it("lists lump-sum lines as not costed, and marks the readings as unused (Estimate 1007 on the test company)", () => {
    // Labor $4,000, materials $3,000, subs $2,000, each a quantity of 1 with no purchase cost.
    const lines: EstimateLine[] = [
      { n: "Labor", c: "labor", a: 4_000, q: 1, u: null, qa: 4_000 },
      { n: "Materials", c: "materials", a: 3_000, q: 1, u: null, qa: 3_000 },
      { n: "Subcontracted Work", c: "subcontractors", a: 2_000, q: 1, u: null, qa: 2_000 },
    ] as EstimateLine[];
    const r = computeEstimateCheck({ amount: 9_000, lines, targetPct: 20, history: roofingAt18(), now: NOW, typeLabel: "Remodel" });
    expect(r.method).not.toBe("quantities");
    expect(r.readingsUnused).toBe(true);
    expect(r.lineReadings).toHaveLength(3);
    expect(r.lineReadings.every((l) => l.cost == null)).toBe(true);
    expect(r.quantityCoverage).toBeNull();
  });

  it("uses no readings flag when the quantities decide", () => {
    const lines: EstimateLine[] = [{ n: "Shingles", c: "materials", a: 3_300, q: 30, u: 100, qa: 3_300 }];
    const r = computeEstimateCheck({ amount: 3_300, lines, targetPct: 5, history: [], now: NOW, typeLabel: "Roofing" });
    expect(r.method).toBe("quantities");
    expect(r.readingsUnused).toBeUndefined();
  });
});
