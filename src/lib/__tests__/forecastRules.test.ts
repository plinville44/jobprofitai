import { describe, it, expect, vi } from "vitest";

// profitability.ts imports the Prisma client for its async wrappers; the
// pure functions tested here never touch it.
vi.mock("../prisma", () => ({ prisma: {} }));

import {
  computeJobFinancials,
  computeForecastAtCompletion,
  computeNeedsAttentionForJob,
  type FinancialContext,
  type JobInput,
} from "../profitability";
import { forecastIsActionable, MIN_ENTERED_PERCENT_TO_PROJECT } from "../forecastRules";

const NOW = new Date("2026-09-28T12:00:00Z");
const recent = new Date(NOW.getTime() - 5 * 86_400_000);

const ctx: FinancialContext = {
  now: NOW,
  targetMarginPct: 25,
  categoryTargetMarginPct: {},
  overheadEnabled: false,
  overheadMethod: null,
  overheadValue: null,
  lastSyncedAt: recent,
};

function job(p: { contract: number; estimate: number | null; spent: number; billed: number; percent?: number | null }): JobInput {
  return {
    id: "j",
    name: "Job",
    customerName: null,
    status: "open",
    category: null,
    estimatedRevenue: p.contract,
    estimatedCost: p.estimate,
    percentCompleteOverride: p.percent ?? null,
    qboCreatedAt: null,
    startDate: null,
    endDate: null,
    updatedAt: recent,
    costEntries: p.spent > 0 ? [{ category: "materials", amount: p.spent, txnDate: recent }] : [],
    invoices: p.billed > 0 ? [{ amount: p.billed, status: "open", txnDate: recent }] : [],
  };
}

describe("forecast from a small entered percent complete (C8)", () => {
  // The audit's case: $100,000 contract, $80,000 estimate, $30,000 of
  // materials delivered, 10% complete entered. Forecast cost $300,000.
  const input = job({ contract: 100_000, estimate: 80_000, spent: 30_000, billed: 0, percent: 10 });
  const f = computeJobFinancials(input, ctx);
  const fc = computeForecastAtCompletion(input, f, NOW);

  it("is low confidence, and says it's an early read", () => {
    expect(fc.available).toBe(true);
    expect(fc.forecastCostAtCompletion).toBe(300_000);
    expect(fc.confidence).toBe("low");
    expect(fc.method).toContain("early read");
  });

  it("raises no feed item or alert", () => {
    expect(forecastIsActionable(f, fc)).toBe(false);
    expect(computeNeedsAttentionForJob(f, { forecast: fc }).some((i) => i.issueCode === "forecast_below_target")).toBe(false);
  });

  it("is refused by the rule even if a forecast claims more confidence", () => {
    expect(forecastIsActionable(f, { ...fc, confidence: "medium" })).toBe(false);
  });

  it("is trusted from 25% complete", () => {
    expect(MIN_ENTERED_PERCENT_TO_PROJECT).toBe(0.25);
    const at25 = job({ contract: 100_000, estimate: 80_000, spent: 30_000, billed: 0, percent: 25 });
    const f25 = computeJobFinancials(at25, ctx);
    const fc25 = computeForecastAtCompletion(at25, f25, NOW);
    expect(fc25.confidence).toBe("high");
    expect(fc25.forecastCostAtCompletion).toBe(120_000);
    expect(forecastIsActionable(f25, fc25)).toBe(true);
    expect(computeNeedsAttentionForJob(f25, { forecast: fc25 }).some((i) => i.issueCode === "forecast_below_target")).toBe(true);
  });
});

describe("forecast on a job whose cost has passed the estimate (C1)", () => {
  it("is unchanged: still worked out from billing, and still not firm enough to warn on", () => {
    // $100,000 contract, $80,000 estimate, $85,000 spent, $60,000 billed.
    const input = job({ contract: 100_000, estimate: 80_000, spent: 85_000, billed: 60_000 });
    const f = computeJobFinancials(input, ctx);
    expect(f.wip?.costPastEstimate).toBe(true);
    const fc = computeForecastAtCompletion(input, f, NOW);
    expect(fc.available).toBe(true);
    expect(fc.progressSource).toBe("billing");
    expect(fc.forecastCostAtCompletion).toBeCloseTo(85_000 / 0.6);
    expect(forecastIsActionable(f, fc)).toBe(false);
    // No "work done, not billed" item from the capped 100% either.
    expect(computeNeedsAttentionForJob(f, { forecast: fc }).some((i) => i.issueCode === "underbilled")).toBe(false);
  });
});
