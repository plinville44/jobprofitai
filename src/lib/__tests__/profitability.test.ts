import { describe, it, expect, vi } from "vitest";
import { subDays } from "date-fns";

// The pure calculation layer (see the "PURE CALCULATION LAYER" comment at
// the top of profitability.ts) never touches Prisma - but the file still has
// a module-level `import { prisma } from "./prisma"` for its async wrapper
// functions, and importing that would otherwise construct a real
// PrismaClient (which throws without `prisma generate` having run, and/or
// without DATABASE_URL set). Mocking it here means this whole suite runs
// against a clean checkout with nothing but `npm install` - no database, no
// env vars, no generated client required - which is the actual promise this
// file's own comments make about the calculation layer being "unit-testable
// with fixture data ... without mocking a database." This is the one thing
// we do mock, and only to avoid an unrelated side effect on import.
vi.mock("../prisma", () => ({ prisma: {} }));

import {
  computeJobFinancials,
  computeNeedsAttentionForJob,
  computeForecastAtCompletion,
  computeProfitLeakage,
  computeDataHealth,
  computeProfitOpportunities,
  computeDashboardTotals,
  findPossibleDuplicateCostEntries,
  type JobInput,
  type FinancialContext,
  type JobFinancials,
  type CostEntryInput,
  type InvoiceInput,
  type ForecastResult,
  type DataHealthReport,
  type NeedsAttentionItem,
} from "../profitability";

const NOW = new Date("2026-06-15T00:00:00Z");

// ---------------------------------------------------------------------------
// Fixture builders - every test overrides only what it's actually testing,
// everything else comes from a known-good default so failures are easy to
// read (the diff is just the field(s) that matter for that case).
// ---------------------------------------------------------------------------

function makeCtx(overrides: Partial<FinancialContext> = {}): FinancialContext {
  return {
    now: NOW,
    targetMarginPct: null,
    categoryTargetMarginPct: {},
    overheadEnabled: false,
    overheadMethod: null,
    overheadValue: null,
    lastSyncedAt: subDays(NOW, 1), // fresh by default
    ...overrides,
  };
}

function makeJob(overrides: Partial<JobInput> = {}): JobInput {
  return {
    id: "job-1",
    name: "Test Job",
    customerName: "Test Customer",
    status: "open",
    category: null,
    estimatedRevenue: null,
    estimatedCost: null,
    startDate: null,
    endDate: null,
    updatedAt: subDays(NOW, 5),
    costEntries: [],
    invoices: [],
    ...overrides,
  };
}

function inv(amount: number, txnDate: Date = subDays(NOW, 5), status = "paid"): InvoiceInput {
  return { amount, status, txnDate };
}
function cost(category: string, amount: number, txnDate: Date = subDays(NOW, 5)): CostEntryInput {
  return { category, amount, txnDate };
}

function makeFinancials(overrides: Partial<JobFinancials> = {}): JobFinancials {
  return {
    jobId: "job-1",
    jobName: "Test Job",
    customerName: "Test Customer",
    status: "open",
    category: null,
    revenue: 10000,
    estimatedRevenue: null,
    costs: 6000,
    estimatedCost: null,
    costByCategory: { materials: 6000 },
    profitabilityAvailable: true,
    unavailableReason: null,
    grossProfit: 4000,
    grossMarginPct: 0.4,
    fullyLoadedProfit: null,
    fullyLoadedMarginPct: null,
    targetMarginPct: null,
    varianceVsEstimate: null,
    varianceVsEstimatePct: null,
    dataConfidence: "medium",
    confidenceReasons: [],
    lastFinancialActivity: subDays(NOW, 5),
    flags: [],
    ...overrides,
  };
}

// ===========================================================================
// computeJobFinancials
// ===========================================================================

describe("computeJobFinancials", () => {
  it("computes a profitable job correctly", () => {
    const f = computeJobFinancials(
      makeJob({ costEntries: [cost("materials", 6000)], invoices: [inv(10000)] }),
      makeCtx()
    );
    expect(f.revenue).toBe(10000);
    expect(f.costs).toBe(6000);
    expect(f.profitabilityAvailable).toBe(true);
    expect(f.grossProfit).toBe(4000);
    expect(f.grossMarginPct).toBeCloseTo(0.4);
  });

  it("computes a loss job correctly (negative profit and margin)", () => {
    const f = computeJobFinancials(
      makeJob({ costEntries: [cost("materials", 7000)], invoices: [inv(5000)] }),
      makeCtx()
    );
    expect(f.grossProfit).toBe(-2000);
    expect(f.grossMarginPct).toBeCloseTo(-0.4);
    expect(f.profitabilityAvailable).toBe(true); // a loss is still a computable, available number
  });

  it("marks profitability unavailable when there's no revenue and no costs", () => {
    const f = computeJobFinancials(makeJob(), makeCtx());
    expect(f.profitabilityAvailable).toBe(false);
    expect(f.unavailableReason).toBe("No revenue or cost data recorded for this job yet.");
    expect(f.grossProfit).toBeNull();
    expect(f.grossMarginPct).toBeNull();
    expect(f.dataConfidence).toBe("insufficient_data");
    expect(f.confidenceReasons).toEqual(["No revenue or cost data recorded for this job yet."]);
  });

  it("marks profitability unavailable for revenue with zero costs (never divides by an incomplete picture)", () => {
    const f = computeJobFinancials(makeJob({ invoices: [inv(5000)] }), makeCtx());
    expect(f.profitabilityAvailable).toBe(false);
    expect(f.unavailableReason).toBe("Profitability unavailable — cost data incomplete.");
    expect(f.flags).toContain("revenue_no_costs");
  });

  it("marks profitability unavailable for costs with zero revenue", () => {
    const f = computeJobFinancials(makeJob({ costEntries: [cost("materials", 3000)] }), makeCtx());
    expect(f.profitabilityAvailable).toBe(false);
    expect(f.unavailableReason).toBe("Costs recorded but no revenue yet — profitability unavailable.");
    expect(f.flags).toContain("costs_no_revenue");
  });

  it("flags no_estimate_on_file when estimatedCost is null, and clears it once an estimate exists", () => {
    const withoutEstimate = computeJobFinancials(
      makeJob({ costEntries: [cost("materials", 1000)], invoices: [inv(2000)] }),
      makeCtx()
    );
    expect(withoutEstimate.flags).toContain("no_estimate_on_file");

    const withEstimate = computeJobFinancials(
      makeJob({ estimatedCost: 1000, costEntries: [cost("materials", 1000)], invoices: [inv(2000)] }),
      makeCtx()
    );
    expect(withEstimate.flags).not.toContain("no_estimate_on_file");
    expect(withEstimate.varianceVsEstimate).toBe(0);
  });

  it("flags over_budget_10pct_plus only when strictly over 10% variance (boundary is exclusive)", () => {
    const at10pct = computeJobFinancials(
      makeJob({ estimatedCost: 1000, costEntries: [cost("materials", 1100)] }),
      makeCtx()
    );
    expect(at10pct.varianceVsEstimatePct).toBeCloseTo(0.1);
    expect(at10pct.flags).not.toContain("over_budget_10pct_plus"); // exactly 10% does not count as "plus"

    const over10pct = computeJobFinancials(
      makeJob({ estimatedCost: 1000, costEntries: [cost("materials", 1101)] }),
      makeCtx()
    );
    expect(over10pct.flags).toContain("over_budget_10pct_plus");
  });

  it("flags below_target_margin only strictly below the target (boundary is exclusive)", () => {
    const atTarget = computeJobFinancials(
      makeJob({ costEntries: [cost("materials", 7000)], invoices: [inv(10000)] }), // 30% margin
      makeCtx({ targetMarginPct: 30 })
    );
    expect(atTarget.flags).not.toContain("below_target_margin");

    const belowTarget = computeJobFinancials(
      makeJob({ costEntries: [cost("materials", 8000)], invoices: [inv(10000)] }), // 20% margin
      makeCtx({ targetMarginPct: 30 })
    );
    expect(belowTarget.flags).toContain("below_target_margin");
  });

  it("uses the category-specific target margin override instead of the connection default", () => {
    const f = computeJobFinancials(
      makeJob({ category: "roofing", costEntries: [cost("materials", 8000)], invoices: [inv(10000)] }), // 20% margin
      makeCtx({ targetMarginPct: 10, categoryTargetMarginPct: { roofing: 40 } })
    );
    expect(f.targetMarginPct).toBe(40);
    expect(f.flags).toContain("below_target_margin"); // 20% < 40% override, even though 20% > 10% connection default
  });

  it("computes Fully Loaded Profit as % of revenue when overhead is enabled that way", () => {
    const f = computeJobFinancials(
      makeJob({ costEntries: [cost("materials", 6000)], invoices: [inv(10000)] }),
      makeCtx({ overheadEnabled: true, overheadMethod: "pct_of_revenue", overheadValue: 0.1 })
    );
    expect(f.fullyLoadedProfit).toBe(3000); // 4000 gross profit - (10000 revenue * 10%)
    expect(f.fullyLoadedMarginPct).toBeCloseTo(0.3);
  });

  it("computes Fully Loaded Profit as % of direct cost when overhead is enabled that way", () => {
    const f = computeJobFinancials(
      makeJob({ costEntries: [cost("materials", 6000)], invoices: [inv(10000)] }),
      makeCtx({ overheadEnabled: true, overheadMethod: "pct_of_direct_cost", overheadValue: 0.15 })
    );
    expect(f.fullyLoadedProfit).toBe(3100); // 4000 gross profit - (6000 costs * 15%)
    expect(f.fullyLoadedMarginPct).toBeCloseTo(0.31);
  });

  it("never computes Fully Loaded Profit when overhead is disabled, even if a method/value is configured", () => {
    const f = computeJobFinancials(
      makeJob({ costEntries: [cost("materials", 6000)], invoices: [inv(10000)] }),
      makeCtx({ overheadEnabled: false, overheadMethod: "pct_of_revenue", overheadValue: 0.1 })
    );
    expect(f.fullyLoadedProfit).toBeNull();
    expect(f.fullyLoadedMarginPct).toBeNull();
  });

  it("handles refunds (negative invoice/cost amounts) as plain reductions, not a special case", () => {
    const f = computeJobFinancials(
      makeJob({
        invoices: [inv(10000), inv(-1500)], // a partial refund
        costEntries: [cost("materials", 5000), cost("materials", -200)], // a returned-material credit
      }),
      makeCtx()
    );
    expect(f.revenue).toBe(8500);
    expect(f.costs).toBe(4800);
    expect(f.costByCategory.materials).toBe(4800);
    expect(f.grossProfit).toBe(3700);
    expect(f.grossMarginPct).toBeCloseTo(3700 / 8500);
  });

  it("flags stale_job for an open job with no synced activity in 30+ days, and only for open jobs", () => {
    const staleOpen = computeJobFinancials(
      makeJob({ invoices: [inv(1000, subDays(NOW, 45))], status: "open" }),
      makeCtx()
    );
    expect(staleOpen.flags).toContain("stale_job");

    const freshOpen = computeJobFinancials(
      makeJob({ invoices: [inv(1000, subDays(NOW, 10))], status: "open" }),
      makeCtx()
    );
    expect(freshOpen.flags).not.toContain("stale_job");

    const staleClosed = computeJobFinancials(
      makeJob({ invoices: [inv(1000, subDays(NOW, 90))], status: "closed" }),
      makeCtx()
    );
    expect(staleClosed.flags).not.toContain("stale_job"); // closed jobs are never "stale"
  });

  it("flags past_end_date_still_open only for open jobs whose end date has passed", () => {
    const overdue = computeJobFinancials(makeJob({ status: "open", endDate: subDays(NOW, 5) }), makeCtx());
    expect(overdue.flags).toContain("past_end_date_still_open");

    const notYetDue = computeJobFinancials(makeJob({ status: "open", endDate: subDays(NOW, -5) }), makeCtx());
    expect(notYetDue.flags).not.toContain("past_end_date_still_open");

    const closedOverdue = computeJobFinancials(makeJob({ status: "closed", endDate: subDays(NOW, 5) }), makeCtx());
    expect(closedOverdue.flags).not.toContain("past_end_date_still_open");
  });

  describe("Data Confidence ladder", () => {
    // All four cases below have real revenue and costs (profitabilityAvailable
    // true) so the ladder itself is what's under test, not the availability gate.
    const profitableJob = (overrides: Partial<JobInput> = {}) =>
      makeJob({ invoices: [inv(2000)], ...overrides });

    it("is high with an estimate, a fresh sync, and 2+ cost categories", () => {
      const f = computeJobFinancials(
        profitableJob({
          estimatedCost: 1000,
          costEntries: [cost("materials", 600), cost("labor", 400)],
        }),
        makeCtx({ lastSyncedAt: subDays(NOW, 5) })
      );
      expect(f.dataConfidence).toBe("high");
      expect(f.confidenceReasons).toEqual([]);
    });

    it("is low with no estimate and a stale sync", () => {
      const f = computeJobFinancials(
        profitableJob({ costEntries: [cost("materials", 600), cost("labor", 400)] }),
        makeCtx({ lastSyncedAt: null })
      );
      expect(f.dataConfidence).toBe("low");
      expect(f.confidenceReasons).toEqual([
        "No cost estimate on file for this job.",
        "QuickBooks data hasn't synced in over 14 days.",
      ]);
    });

    it("is low with no estimate and only one cost category, even with a fresh sync", () => {
      const f = computeJobFinancials(
        profitableJob({ costEntries: [cost("materials", 1000)] }),
        makeCtx({ lastSyncedAt: subDays(NOW, 5) })
      );
      expect(f.dataConfidence).toBe("low");
      expect(f.confidenceReasons).toEqual([
        "No cost estimate on file for this job.",
        "Costs are only recorded in one category so far.",
      ]);
    });

    it("is medium when there's an estimate but the sync is stale", () => {
      const f = computeJobFinancials(
        profitableJob({
          estimatedCost: 1000,
          costEntries: [cost("materials", 600), cost("labor", 400)],
        }),
        makeCtx({ lastSyncedAt: subDays(NOW, 20) })
      );
      expect(f.dataConfidence).toBe("medium");
      expect(f.confidenceReasons).toEqual(["QuickBooks data hasn't synced in over 14 days."]);
    });

    it("is medium with no estimate but a fresh sync and 2+ categories (better than low, not as good as high)", () => {
      const f = computeJobFinancials(
        profitableJob({ costEntries: [cost("materials", 600), cost("labor", 400)] }),
        makeCtx({ lastSyncedAt: subDays(NOW, 5) })
      );
      expect(f.dataConfidence).toBe("medium");
      expect(f.confidenceReasons).toEqual(["No cost estimate on file for this job."]);
    });
  });
});

// ===========================================================================
// computeNeedsAttentionForJob
// ===========================================================================

describe("computeNeedsAttentionForJob", () => {
  it("raises revenue_no_costs", () => {
    const items = computeNeedsAttentionForJob(makeFinancials({ flags: ["revenue_no_costs"] }));
    expect(items.map((i) => i.issueCode)).toContain("revenue_no_costs");
  });

  it("raises costs_no_revenue_completed only for closed jobs", () => {
    const closed = computeNeedsAttentionForJob(
      makeFinancials({ flags: ["costs_no_revenue"], status: "closed" })
    );
    expect(closed.map((i) => i.issueCode)).toContain("costs_no_revenue_completed");

    const open = computeNeedsAttentionForJob(makeFinancials({ flags: ["costs_no_revenue"], status: "open" }));
    expect(open.map((i) => i.issueCode)).not.toContain("costs_no_revenue_completed");
  });

  it("raises no_estimate_on_file", () => {
    const items = computeNeedsAttentionForJob(makeFinancials({ flags: ["no_estimate_on_file"] }));
    expect(items.map((i) => i.issueCode)).toContain("no_estimate_on_file");
  });

  it("computes below_target_margin's financial impact and severity from the actual gap", () => {
    const high = computeNeedsAttentionForJob(
      makeFinancials({ flags: ["below_target_margin"], grossMarginPct: 0.2, targetMarginPct: 35, revenue: 10000 })
    )[0];
    expect(high.issue).toBe("Margin is 15.0 points below your 35% target");
    expect(high.financialImpact).toBeCloseTo(1500); // 10000 * (15/100)
    expect(high.severity).toBe("high"); // gap > 10

    const medium = computeNeedsAttentionForJob(
      makeFinancials({ flags: ["below_target_margin"], grossMarginPct: 0.2, targetMarginPct: 27, revenue: 10000 })
    )[0];
    expect(medium.severity).toBe("medium"); // gap of 7, > 5 and <= 10

    const low = computeNeedsAttentionForJob(
      makeFinancials({ flags: ["below_target_margin"], grossMarginPct: 0.2, targetMarginPct: 23, revenue: 10000 })
    )[0];
    expect(low.severity).toBe("low"); // gap of 3, <= 5

    const noRevenue = computeNeedsAttentionForJob(
      makeFinancials({ flags: ["below_target_margin"], grossMarginPct: 0.2, targetMarginPct: 35, revenue: 0 })
    )[0];
    expect(noRevenue.financialImpact).toBeNull(); // never guess a dollar impact with no revenue to apply the gap to
  });

  it("severity for over_budget is high above 25% variance, medium otherwise", () => {
    const high = computeNeedsAttentionForJob(
      makeFinancials({ flags: ["over_budget_10pct_plus"], varianceVsEstimate: 3000, varianceVsEstimatePct: 0.3 })
    )[0];
    expect(high.issue).toBe("Actual costs are 30% over the estimate");
    expect(high.financialImpact).toBe(3000);
    expect(high.severity).toBe("high");

    const medium = computeNeedsAttentionForJob(
      makeFinancials({ flags: ["over_budget_10pct_plus"], varianceVsEstimate: 1500, varianceVsEstimatePct: 0.15 })
    )[0];
    expect(medium.severity).toBe("medium");
  });

  it("raises stale_job", () => {
    const items = computeNeedsAttentionForJob(makeFinancials({ flags: ["stale_job"] }));
    expect(items.map((i) => i.issueCode)).toContain("stale_job");
  });

  describe("margin_declining", () => {
    it("fires on a genuine downward trend with at least 2 prior points", () => {
      const items = computeNeedsAttentionForJob(makeFinancials({ grossMarginPct: 0.2 }), {
        priorMarginPcts: [0.3, 0.25],
      });
      const item = items.find((i) => i.issueCode === "margin_declining");
      expect(item).toBeDefined();
      expect(item?.confidence).toBe("medium"); // only 2 prior points

      const withMorePriors = computeNeedsAttentionForJob(makeFinancials({ grossMarginPct: 0.2 }), {
        priorMarginPcts: [0.3, 0.28, 0.25],
      });
      expect(withMorePriors.find((i) => i.issueCode === "margin_declining")?.confidence).toBe("high"); // 3+ prior points
    });

    it("does not fire on a flat trend (declining requires an actual decrease)", () => {
      const items = computeNeedsAttentionForJob(makeFinancials({ grossMarginPct: 0.3 }), {
        priorMarginPcts: [0.3, 0.3],
      });
      expect(items.map((i) => i.issueCode)).not.toContain("margin_declining");
    });

    it("does not fire on a non-monotonic trend (a dip that recovers isn't 'declining')", () => {
      const items = computeNeedsAttentionForJob(makeFinancials({ grossMarginPct: 0.25 }), {
        priorMarginPcts: [0.2, 0.3],
      });
      expect(items.map((i) => i.issueCode)).not.toContain("margin_declining");
    });

    it("does not fire with fewer than 2 prior data points", () => {
      const items = computeNeedsAttentionForJob(makeFinancials({ grossMarginPct: 0.1 }), {
        priorMarginPcts: [0.3],
      });
      expect(items.map((i) => i.issueCode)).not.toContain("margin_declining");
    });
  });

  describe("cost_outlier", () => {
    it("fires when a category's cost is more than 1.5x the peer median, with at least 3 peers", () => {
      const items = computeNeedsAttentionForJob(makeFinancials({ costByCategory: { materials: 1500 } }), {
        peerCompletedCostByCategory: { materials: [800, 900, 1000] }, // median 900
      });
      const item = items.find((i) => i.issueCode === "cost_outlier");
      expect(item).toBeDefined();
      expect(item?.financialImpact).toBe(600); // 1500 - 900 median
      expect(item?.confidence).toBe("medium"); // 3 peers, not yet 5
    });

    it("raises confidence to high with 5+ peers", () => {
      const items = computeNeedsAttentionForJob(makeFinancials({ costByCategory: { materials: 1500 } }), {
        peerCompletedCostByCategory: { materials: [800, 850, 900, 950, 1000] }, // median 900
      });
      expect(items.find((i) => i.issueCode === "cost_outlier")?.confidence).toBe("high");
    });

    it("does not fire with fewer than 3 peers", () => {
      const items = computeNeedsAttentionForJob(makeFinancials({ costByCategory: { materials: 1500 } }), {
        peerCompletedCostByCategory: { materials: [800, 900] },
      });
      expect(items.map((i) => i.issueCode)).not.toContain("cost_outlier");
    });

    it("does not fire when the cost isn't actually an outlier", () => {
      const items = computeNeedsAttentionForJob(makeFinancials({ costByCategory: { materials: 1300 } }), {
        peerCompletedCostByCategory: { materials: [800, 900, 1000] }, // median 900, threshold 1350
      });
      expect(items.map((i) => i.issueCode)).not.toContain("cost_outlier");
    });
  });
});

// ===========================================================================
// computeForecastAtCompletion
// ===========================================================================

describe("computeForecastAtCompletion", () => {
  const openJob = (overrides: Partial<JobInput> = {}) => makeJob({ status: "open", ...overrides });

  it("is unavailable for a closed job", () => {
    const result = computeForecastAtCompletion(
      makeJob({ status: "closed" }),
      makeFinancials({ estimatedCost: 1000, costs: 500 }),
      NOW
    );
    expect(result.available).toBe(false);
    expect(result.reason).toBe("Not enough data to create a reliable forecast.");
  });

  it("is unavailable with no cost estimate on file", () => {
    const result = computeForecastAtCompletion(openJob(), makeFinancials({ estimatedCost: null, costs: 500 }), NOW);
    expect(result.available).toBe(false);
  });

  it("is unavailable with zero actual costs recorded", () => {
    const result = computeForecastAtCompletion(openJob(), makeFinancials({ estimatedCost: 1000, costs: 0 }), NOW);
    expect(result.available).toBe(false);
  });

  it("is unavailable with no recent financial activity (including no activity at all)", () => {
    const stale = computeForecastAtCompletion(
      openJob(),
      makeFinancials({ estimatedCost: 1000, costs: 500, lastFinancialActivity: subDays(NOW, 45) }),
      NOW
    );
    expect(stale.available).toBe(false);

    const never = computeForecastAtCompletion(
      openJob(),
      makeFinancials({ estimatedCost: 1000, costs: 500, lastFinancialActivity: null }),
      NOW
    );
    expect(never.available).toBe(false); // no activity at all -> infinite days since -> treated the same as stale, never crashes
  });

  it("clamps the forecast to the estimate when running under budget so far (never forecasts below the estimate)", () => {
    const result = computeForecastAtCompletion(
      openJob(),
      makeFinancials({
        estimatedCost: 10000,
        costs: 4000, // 40% spent so far, under the run-rate that would imply completion under budget
        estimatedRevenue: 15000,
        revenue: 0,
        lastFinancialActivity: subDays(NOW, 5),
      }),
      NOW
    );
    expect(result.available).toBe(true);
    expect(result.forecastCostAtCompletion).toBe(10000); // clamped, not extrapolated below the estimate
    expect(result.forecastProfit).toBe(5000); // 15000 estimated revenue - 10000
    expect(result.forecastMarginPct).toBeCloseTo(5000 / 15000);
    expect(result.confidence).toBe("medium"); // 40% of estimate spent - >=20%, <50%
  });

  it("extrapolates the overrun rate when already running over budget", () => {
    const result = computeForecastAtCompletion(
      openJob(),
      makeFinancials({
        estimatedCost: 10000,
        costs: 13000, // 30% over already
        estimatedRevenue: 15000,
        revenue: 0,
        lastFinancialActivity: subDays(NOW, 5),
      }),
      NOW
    );
    expect(result.forecastCostAtCompletion).toBe(13000);
    expect(result.forecastProfit).toBe(2000); // 15000 - 13000
    expect(result.confidence).toBe("high"); // 130% of estimate already spent - well past the 50% bar
  });

  it("falls back to actual revenue when there's no estimated revenue on file", () => {
    const result = computeForecastAtCompletion(
      openJob(),
      makeFinancials({
        estimatedCost: 10000,
        costs: 5000,
        estimatedRevenue: null,
        revenue: 12000,
        lastFinancialActivity: subDays(NOW, 5),
      }),
      NOW
    );
    expect(result.forecastProfit).toBe(2000); // 12000 actual revenue - 10000 forecast cost
  });

  it("confidence tracks how much of the estimate has actually been spent (boundaries are inclusive)", () => {
    const low = computeForecastAtCompletion(
      openJob(),
      makeFinancials({ estimatedCost: 10000, costs: 1999, lastFinancialActivity: subDays(NOW, 5) }),
      NOW
    );
    expect(low.confidence).toBe("low");

    const medium = computeForecastAtCompletion(
      openJob(),
      makeFinancials({ estimatedCost: 10000, costs: 2000, lastFinancialActivity: subDays(NOW, 5) }),
      NOW
    );
    expect(medium.confidence).toBe("medium"); // exactly 20%, inclusive

    const high = computeForecastAtCompletion(
      openJob(),
      makeFinancials({ estimatedCost: 10000, costs: 5000, lastFinancialActivity: subDays(NOW, 5) }),
      NOW
    );
    expect(high.confidence).toBe("high"); // exactly 50%, inclusive
  });
});

// ===========================================================================
// computeProfitLeakage
// ===========================================================================

describe("computeProfitLeakage", () => {
  const unavailableForecast: ForecastResult = { available: false, reason: "n/a" };

  it("returns null without both an estimated cost and an estimated revenue to bridge from", () => {
    expect(computeProfitLeakage(makeFinancials({ estimatedCost: null, estimatedRevenue: 15000 }), unavailableForecast)).toBeNull();
    expect(computeProfitLeakage(makeFinancials({ estimatedCost: 10000, estimatedRevenue: null }), unavailableForecast)).toBeNull();
  });

  it("bridges expected profit to actual profit through revenue and cost variance", () => {
    const steps = computeProfitLeakage(
      makeFinancials({
        estimatedRevenue: 15000,
        estimatedCost: 10000,
        revenue: 14000,
        costs: 11000,
        fullyLoadedProfit: null,
        grossProfit: 3000,
        status: "closed",
      }),
      unavailableForecast
    )!;

    expect(steps[0]).toEqual({ label: "Expected profit", value: 5000, isTotal: true }); // 15000 - 10000
    expect(steps[1]).toEqual({ label: "Revenue vs. estimate", value: -1000, isTotal: false }); // 14000 - 15000
    expect(steps[2]).toEqual({ label: "Cost vs. estimate", value: -1000, isTotal: false }); // 10000 - 11000
    // No overhead step when fullyLoadedProfit is null.
    expect(steps.some((s) => s.label === "Overhead allocation")).toBe(false);
  });

  it("includes an overhead allocation step only when Fully Loaded Profit is present", () => {
    const steps = computeProfitLeakage(
      makeFinancials({
        estimatedRevenue: 15000,
        estimatedCost: 10000,
        revenue: 14000,
        costs: 11000,
        grossProfit: 3000,
        fullyLoadedProfit: 2500,
      }),
      unavailableForecast
    )!;
    const overheadStep = steps.find((s) => s.label === "Overhead allocation");
    expect(overheadStep).toEqual({ label: "Overhead allocation", value: -500, isTotal: false }); // 2500 - 3000
  });

  it("prefers Fully Loaded Profit, then Gross Profit, then the running total, for the closing figure", () => {
    const base = { estimatedRevenue: 15000, estimatedCost: 10000, revenue: 14000, costs: 11000, status: "closed" as const };

    const withFullyLoaded = computeProfitLeakage(makeFinancials({ ...base, fullyLoadedProfit: 111 }), unavailableForecast)!;
    expect(withFullyLoaded[withFullyLoaded.length - 1].value).toBe(111);

    const withGrossOnly = computeProfitLeakage(
      makeFinancials({ ...base, fullyLoadedProfit: null, grossProfit: 222 }),
      unavailableForecast
    )!;
    expect(withGrossOnly[withGrossOnly.length - 1].value).toBe(222);

    const withNeitherFallsBackToRunningTotal = computeProfitLeakage(
      makeFinancials({ ...base, fullyLoadedProfit: null, grossProfit: null }),
      unavailableForecast
    )!;
    // running total = expectedProfit(5000) + revenueVariance(-1000) + costVariance(-1000) = 3000
    expect(withNeitherFallsBackToRunningTotal[withNeitherFallsBackToRunningTotal.length - 1].value).toBe(3000);
  });

  it("labels the closing step 'Forecast profit' only for an open job with an available forecast", () => {
    const availableForecast: ForecastResult = { available: true, forecastProfit: 5500 };

    const openWithForecast = computeProfitLeakage(
      makeFinancials({ estimatedRevenue: 15000, estimatedCost: 10000, revenue: 14000, costs: 11000, status: "open", fullyLoadedProfit: 999 }),
      availableForecast
    )!;
    const lastOpen = openWithForecast[openWithForecast.length - 1];
    expect(lastOpen.label).toBe("Forecast profit");
    expect(lastOpen.value).toBe(5500); // the forecast wins even over a set Fully Loaded Profit

    const openWithoutForecast = computeProfitLeakage(
      makeFinancials({ estimatedRevenue: 15000, estimatedCost: 10000, revenue: 14000, costs: 11000, status: "open", grossProfit: 3000 }),
      unavailableForecast
    )!;
    // Open, but no forecast to show - falls back to "Actual profit" rather than mislabeling a non-existent forecast.
    expect(openWithoutForecast[openWithoutForecast.length - 1].label).toBe("Actual profit");
  });
});

// ===========================================================================
// computeDataHealth
// ===========================================================================

describe("computeDataHealth", () => {
  it("collects jobs missing estimates, jobs missing costs, and completed jobs with unresolved activity", () => {
    const jobs = [
      makeFinancials({ jobId: "a", estimatedCost: null }),
      makeFinancials({ jobId: "b", estimatedCost: 1000 }),
      makeFinancials({ jobId: "c", revenue: 5000, costs: 0 }),
      makeFinancials({ jobId: "d", status: "closed", flags: ["revenue_no_costs"] }),
      makeFinancials({ jobId: "e", status: "closed", flags: [] }),
    ];
    const health = computeDataHealth(jobs, NOW, null);
    expect(health.jobsMissingEstimates.map((j) => j.jobId)).toEqual(["a", "c", "d", "e"]); // all default estimatedCost:null except "b"
    expect(health.jobsMissingCosts.map((j) => j.jobId)).toEqual(["c"]);
    expect(health.completedJobsWithUnresolvedActivity.map((j) => j.jobId)).toEqual(["d"]);
  });

  it("computes days-since-activity for stale jobs, treating no activity at all as infinite", () => {
    const jobs = [
      makeFinancials({ jobId: "stale", status: "open", flags: ["stale_job"], lastFinancialActivity: subDays(NOW, 40) }),
      makeFinancials({ jobId: "never-active", status: "open", flags: ["stale_job"], lastFinancialActivity: null }),
    ];
    const health = computeDataHealth(jobs, NOW, null);
    const stale = health.staleJobs.find((j) => j.jobId === "stale");
    const neverActive = health.staleJobs.find((j) => j.jobId === "never-active");
    expect(stale?.daysSinceActivity).toBe(40);
    expect(neverActive?.daysSinceActivity).toBe(Infinity);
  });

  it("reports unmeasured (null) sync-derived counts distinctly from a measured zero", () => {
    const jobs = [makeFinancials()];

    const noSyncYet = computeDataHealth(jobs, NOW, null);
    expect(noSyncYet.unassignedExpenseCount).toBeNull();
    expect(noSyncYet.unresolvedExpenseCount).toBeNull();
    expect(noSyncYet.costsMatchedViaParentCount).toBeNull();

    const measuredZero = computeDataHealth(jobs, NOW, { unassignedExpenseCount: 0, unassignedExpenseAmount: 0 });
    expect(measuredZero.unassignedExpenseCount).toBe(0); // a real, counted zero - not "not yet measured"
    expect(measuredZero.unresolvedExpenseCount).toBeNull(); // this key wasn't in the sync record at all - still unmeasured

    const measuredNonZero = computeDataHealth(jobs, NOW, {
      unassignedExpenseCount: 5,
      unassignedExpenseAmount: 750,
      unresolvedExpenseCount: 2,
      unresolvedExpenseAmount: 300,
      costsMatchedViaParentCount: 1,
      costsMatchedViaParentAmount: 400,
    });
    expect(measuredNonZero.unassignedExpenseCount).toBe(5);
    expect(measuredNonZero.unassignedExpenseAmount).toBe(750);
    expect(measuredNonZero.unresolvedExpenseCount).toBe(2);
    expect(measuredNonZero.costsMatchedViaParentCount).toBe(1);
  });

  it("never populates possibleDuplicates itself (that's merged in separately by the async wrapper)", () => {
    const health = computeDataHealth([makeFinancials()], NOW, null);
    expect(health.possibleDuplicates).toEqual([]);
  });

  describe("overallConfidence", () => {
    it("is insufficient_data with zero jobs", () => {
      expect(computeDataHealth([], NOW, null).overallConfidence).toBe("insufficient_data");
    });

    it("is low when more than half of jobs have insufficient_data confidence", () => {
      const jobs = [
        makeFinancials({ dataConfidence: "insufficient_data" }),
        makeFinancials({ dataConfidence: "insufficient_data" }),
        makeFinancials({ dataConfidence: "high" }),
      ];
      expect(computeDataHealth(jobs, NOW, null).overallConfidence).toBe("low"); // 2/3
    });

    it("is medium when more than 20% but at most half are insufficient_data", () => {
      const jobs = [
        makeFinancials({ dataConfidence: "insufficient_data" }),
        makeFinancials({ dataConfidence: "insufficient_data" }),
        makeFinancials({ dataConfidence: "high" }),
        makeFinancials({ dataConfidence: "high" }),
        makeFinancials({ dataConfidence: "high" }),
      ];
      expect(computeDataHealth(jobs, NOW, null).overallConfidence).toBe("medium"); // 2/5 = 0.4
    });

    it("is high when 20% or fewer jobs are insufficient_data", () => {
      const jobs = Array.from({ length: 10 }, (_, i) => makeFinancials({ dataConfidence: i === 0 ? "insufficient_data" : "high" }));
      expect(computeDataHealth(jobs, NOW, null).overallConfidence).toBe("high"); // 1/10
    });
  });
});

// ===========================================================================
// computeProfitOpportunities
// ===========================================================================

describe("computeProfitOpportunities", () => {
  it("flags recurring underestimation in a category with 3+ completed jobs averaging over 10% over estimate", () => {
    const jobs = [
      makeFinancials({ jobId: "a", status: "closed", category: "roofing", varianceVsEstimatePct: 0.2, varianceVsEstimate: 1000 }),
      makeFinancials({ jobId: "b", status: "closed", category: "roofing", varianceVsEstimatePct: 0.15, varianceVsEstimate: 750 }),
      makeFinancials({ jobId: "c", status: "closed", category: "roofing", varianceVsEstimatePct: 0.25, varianceVsEstimate: 1250 }),
    ];
    const opps = computeProfitOpportunities(jobs).filter((o) => o.type === "recurring_underestimation");
    expect(opps).toHaveLength(1);
    expect(opps[0].financialImpact).toBeCloseTo(3000); // avg $1000 over * 3 jobs
    expect(opps[0].confidence).toBe("medium"); // 3 jobs, not yet 5
    expect(opps[0].supportingJobIds.sort()).toEqual(["a", "b", "c"]);
  });

  it("raises recurring_underestimation confidence to high with 5+ jobs", () => {
    const jobs = Array.from({ length: 5 }, (_, i) =>
      makeFinancials({ jobId: `j${i}`, status: "closed", category: "roofing", varianceVsEstimatePct: 0.2, varianceVsEstimate: 1000 })
    );
    const opp = computeProfitOpportunities(jobs).find((o) => o.type === "recurring_underestimation");
    expect(opp?.confidence).toBe("high");
  });

  it("does not flag recurring underestimation with fewer than 3 completed jobs in a category", () => {
    const jobs = [
      makeFinancials({ jobId: "a", status: "closed", category: "roofing", varianceVsEstimatePct: 0.5, varianceVsEstimate: 5000 }),
      makeFinancials({ jobId: "b", status: "closed", category: "roofing", varianceVsEstimatePct: 0.5, varianceVsEstimate: 5000 }),
    ];
    expect(computeProfitOpportunities(jobs).filter((o) => o.type === "recurring_underestimation")).toHaveLength(0);
  });

  it("does not flag recurring underestimation at or below the 10% overrun threshold", () => {
    // Deliberately not testing exactly-0.1 here: computeProfitOpportunities
    // averages three separate varianceVsEstimatePct values via repeated
    // addition, and 0.1 + 0.1 + 0.1 in floating point is 0.30000000000000004,
    // not 0.3 - dividing that by 3 lands a hair *above* 0.1, which would
    // fail this test for a floating-point rounding reason that has nothing
    // to do with whether the ">" threshold in the source is correct. Using a
    // value clearly under 10% (8%) proves the same "at-or-below doesn't
    // trigger" behavior without depending on exact floating-point equality.
    // The over-10% side is already covered by the "flags recurring
    // underestimation..." test above.
    const jobs = Array.from({ length: 3 }, (_, i) =>
      makeFinancials({ jobId: `j${i}`, status: "closed", category: "roofing", varianceVsEstimatePct: 0.08, varianceVsEstimate: 400 })
    );
    expect(computeProfitOpportunities(jobs).filter((o) => o.type === "recurring_underestimation")).toHaveLength(0);
  });

  // low_margin_category and high_performing_category are evaluated over the
  // same `byCategory` grouping recurring_underestimation uses, which only
  // includes jobs that also have a non-null varianceVsEstimatePct (i.e. an
  // estimate on file) - see computeProfitOpportunities in profitability.ts.
  // A job with no estimate never enters any of the three groupings, so every
  // fixture below sets varianceVsEstimatePct even though these two rules
  // don't otherwise use it.

  it("flags a category consistently missing target margin (60%+ of jobs below target, 3+ jobs)", () => {
    const jobs = [
      makeFinancials({ jobId: "a", status: "closed", category: "remodel", grossMarginPct: 0.2, targetMarginPct: 25, varianceVsEstimatePct: 0 }),
      makeFinancials({ jobId: "b", status: "closed", category: "remodel", grossMarginPct: 0.18, targetMarginPct: 25, varianceVsEstimatePct: 0 }),
      makeFinancials({ jobId: "c", status: "closed", category: "remodel", grossMarginPct: 0.3, targetMarginPct: 25, varianceVsEstimatePct: 0 }),
    ];
    const opp = computeProfitOpportunities(jobs).find((o) => o.type === "low_margin_category");
    expect(opp).toBeDefined(); // 2 of 3 below target = 66.7%
  });

  it("does not flag low_margin_category below the 60% threshold", () => {
    const jobs = [
      makeFinancials({ jobId: "a", status: "closed", category: "remodel", grossMarginPct: 0.2, targetMarginPct: 25, varianceVsEstimatePct: 0 }),
      makeFinancials({ jobId: "b", status: "closed", category: "remodel", grossMarginPct: 0.3, targetMarginPct: 25, varianceVsEstimatePct: 0 }),
      makeFinancials({ jobId: "c", status: "closed", category: "remodel", grossMarginPct: 0.4, targetMarginPct: 25, varianceVsEstimatePct: 0 }),
    ];
    expect(computeProfitOpportunities(jobs).filter((o) => o.type === "low_margin_category")).toHaveLength(0); // 1 of 3 = 33%
  });

  it("flags a high-performing category (25%+ above the overall average, and itself positive)", () => {
    const jobs = [
      makeFinancials({ jobId: "r1", status: "closed", category: "roofing", grossMarginPct: 0.4, varianceVsEstimatePct: 0 }),
      makeFinancials({ jobId: "r2", status: "closed", category: "roofing", grossMarginPct: 0.42, varianceVsEstimatePct: 0 }),
      makeFinancials({ jobId: "r3", status: "closed", category: "roofing", grossMarginPct: 0.38, varianceVsEstimatePct: 0 }),
      makeFinancials({ jobId: "m1", status: "closed", category: "remodel", grossMarginPct: 0.1, varianceVsEstimatePct: 0 }),
      makeFinancials({ jobId: "m2", status: "closed", category: "remodel", grossMarginPct: 0.12, varianceVsEstimatePct: 0 }),
      makeFinancials({ jobId: "m3", status: "closed", category: "remodel", grossMarginPct: 0.08, varianceVsEstimatePct: 0 }),
    ];
    const opps = computeProfitOpportunities(jobs).filter((o) => o.type === "high_performing_category");
    // Overall average is 0.25; roofing averages 0.4 (> 0.25 * 1.25 = 0.3125) - qualifies.
    // Remodel averages 0.1, well under the bar - does not qualify.
    expect(opps.map((o) => o.title)).toEqual([expect.stringContaining("Roofing")]);
  });

  it("returns no opportunities when there isn't enough completed-job history", () => {
    const jobs = [makeFinancials({ status: "open" }), makeFinancials({ status: "open" })];
    expect(computeProfitOpportunities(jobs)).toEqual([]);
  });
});

// ===========================================================================
// computeDashboardTotals
// ===========================================================================

describe("computeDashboardTotals", () => {
  const dataHealth: DataHealthReport = {
    jobsMissingEstimates: [{ jobId: "a", jobName: "A" }],
    jobsMissingCosts: [{ jobId: "b", jobName: "B" }],
    staleJobs: [],
    completedJobsWithUnresolvedActivity: [{ jobId: "c", jobName: "C" }],
    unassignedExpenseCount: 4,
    unassignedExpenseAmount: 400,
    unresolvedExpenseCount: null, // unmeasured - must contribute 0, not throw or NaN
    unresolvedExpenseAmount: null,
    costsMatchedViaParentCount: 999, // deliberately large, to prove it's excluded from dataIssues
    costsMatchedViaParentAmount: 999,
    possibleDuplicates: [{ jobId: "d", jobName: "D", amount: 100, date: "2026-06-01" }],
    overallConfidence: "medium",
  };

  it("sums revenue/costs/profit and computes the below-target and profit-at-risk figures", () => {
    const jobs = [
      makeFinancials({ jobId: "a", status: "open", revenue: 10000, costs: 6000, grossMarginPct: 0.4, flags: [] }),
      makeFinancials({ jobId: "b", status: "open", revenue: 5000, costs: 4500, grossMarginPct: 0.1, flags: ["below_target_margin"] }),
      makeFinancials({ jobId: "c", status: "closed", revenue: 8000, costs: 5000, grossMarginPct: 0.375, flags: [] }),
    ];
    const needsAttention: NeedsAttentionItem[] = [
      { jobId: "b", jobName: "B", issueCode: "below_target_margin", issue: "...", financialImpact: 750, severity: "medium", confidence: "high" },
      { jobId: "b", jobName: "B", issueCode: "over_budget", issue: "...", financialImpact: 99999, severity: "high", confidence: "high" }, // must NOT count toward profitAtRisk
    ];

    const totals = computeDashboardTotals(jobs, needsAttention, dataHealth, 30);

    expect(totals.activeJobs).toBe(2); // only the 2 "open" jobs
    expect(totals.revenue).toBe(23000);
    expect(totals.trackedJobCosts).toBe(15500);
    expect(totals.jobGrossProfit).toBe(7500);
    expect(totals.avgJobMarginPct).toBeCloseTo((0.4 + 0.1 + 0.375) / 3);
    expect(totals.jobsBelowTarget).toBe(1);
    expect(totals.profitAtRisk).toBe(750); // only the below_target_margin item counts, not the over_budget one
  });

  it("returns a null average margin when no job has a computable margin", () => {
    const jobs = [makeFinancials({ grossMarginPct: null }), makeFinancials({ grossMarginPct: null })];
    expect(computeDashboardTotals(jobs, [], dataHealth, null).avgJobMarginPct).toBeNull();
  });

  it("sums dataIssues from real counted gaps, treats unmeasured counts as 0, and excludes the parent-match count", () => {
    const totals = computeDashboardTotals([], [], dataHealth, null);
    // 1 (missing estimates) + 1 (missing costs) + 0 (stale) + 1 (unresolved activity)
    // + 4 (unassigned, measured) + 0 (unresolved, unmeasured -> treated as 0) + 1 (possible duplicate)
    // costsMatchedViaParentCount (999) is deliberately NOT part of this sum.
    expect(totals.dataIssues).toBe(8);
  });
});

// ===========================================================================
// findPossibleDuplicateCostEntries
// ===========================================================================

describe("findPossibleDuplicateCostEntries", () => {
  const entry = (qboSourceId: string, amount: number, txnDate: Date) => ({ qboSourceId, amount: amount as any, txnDate });

  it("flags two cost entries on the same job with the same amount and day but different source transactions", () => {
    const day = new Date("2026-06-10T12:00:00Z");
    const jobs = [
      {
        id: "job-1",
        name: "Ocean View Road",
        costEntries: [entry("Purchase-1", 500, day), entry("Bill-1", 500, day)],
      },
    ];
    const dupes = findPossibleDuplicateCostEntries(jobs);
    expect(dupes).toEqual([{ jobId: "job-1", jobName: "Ocean View Road", amount: 500, date: "2026-06-10" }]);
  });

  it("flags a duplicate only once even when a third matching entry appears", () => {
    const day = new Date("2026-06-10T12:00:00Z");
    const jobs = [
      {
        id: "job-1",
        name: "Ocean View Road",
        costEntries: [entry("Purchase-1", 500, day), entry("Bill-1", 500, day), entry("Bill-2", 500, day)],
      },
    ];
    expect(findPossibleDuplicateCostEntries(jobs)).toHaveLength(1);
  });

  it("does not flag the same source transaction appearing twice as a duplicate of itself", () => {
    const day = new Date("2026-06-10T12:00:00Z");
    const jobs = [{ id: "job-1", name: "Job", costEntries: [entry("Purchase-1", 500, day), entry("Purchase-1", 500, day)] }];
    expect(findPossibleDuplicateCostEntries(jobs)).toEqual([]);
  });

  it("does not cross-flag between different jobs", () => {
    const day = new Date("2026-06-10T12:00:00Z");
    const jobs = [
      { id: "job-1", name: "Job A", costEntries: [entry("Purchase-1", 500, day)] },
      { id: "job-2", name: "Job B", costEntries: [entry("Purchase-2", 500, day)] },
    ];
    expect(findPossibleDuplicateCostEntries(jobs)).toEqual([]);
  });

  it("does not flag entries with different amounts or different days", () => {
    const day = new Date("2026-06-10T12:00:00Z");
    const nextDay = new Date("2026-06-11T12:00:00Z");
    const jobs = [
      {
        id: "job-1",
        name: "Job",
        costEntries: [entry("Purchase-1", 500, day), entry("Bill-1", 501, day), entry("Bill-2", 500, nextDay)],
      },
    ];
    expect(findPossibleDuplicateCostEntries(jobs)).toEqual([]);
  });
});
