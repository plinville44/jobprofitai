import { describe, it, expect, vi } from "vitest";

// profitability.ts imports the Prisma client for its async wrappers; the
// pure functions tested here never touch it.
vi.mock("../prisma", () => ({ prisma: {} }));

import { computeJobFinancials, computeNeedsAttentionForJob, type FinancialContext, type JobFinancials, type JobInput } from "../profitability";
import { buildWipSchedule, estimatedTotalCostOf, isIdleOpenJob, wipCountsInTotals, NOT_SCHEDULED_NEED_TEXT } from "../wipSchedule";

const NOW = new Date("2026-09-28T12:00:00Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000);

const ctx: FinancialContext = {
  now: NOW,
  targetMarginPct: 25,
  categoryTargetMarginPct: {},
  overheadEnabled: false,
  overheadMethod: null,
  overheadValue: null,
  lastSyncedAt: daysAgo(1),
};

/** A job built through computeJobFinancials, so the WIP figures are the real ones. */
function openJob(p: {
  id: string;
  contract: number | null;
  estimate: number | null;
  spent: number;
  billed: number;
  percent?: number | null;
  lastActivityDaysAgo?: number;
  createdDaysAgo?: number | null;
}): JobFinancials {
  const when = daysAgo(p.lastActivityDaysAgo ?? 5);
  const input: JobInput = {
    id: p.id,
    name: p.id,
    customerName: null,
    status: "open",
    category: null,
    estimatedRevenue: p.contract,
    estimatedCost: p.estimate,
    percentCompleteOverride: p.percent ?? null,
    qboCreatedAt: p.createdDaysAgo === null ? null : daysAgo(p.createdDaysAgo ?? 200),
    startDate: null,
    endDate: null,
    updatedAt: when,
    costEntries: p.spent > 0 ? [{ category: "materials", amount: p.spent, txnDate: when }] : [],
    invoices: p.billed > 0 ? [{ amount: p.billed, status: "open", txnDate: when }] : [],
  };
  return computeJobFinancials(input, ctx);
}

describe("WIP schedule: jobs whose cost has passed the estimate (C1)", () => {
  // The audit's case: $100,000 contract, $80,000 estimate, $85,000 spent,
  // $60,000 billed. Cost-to-cost capped it at 100%: earned $100,000, under
  // billed $40,000, gross profit to date +$15,000.
  const overrun = () => openJob({ id: "Overrun", contract: 100_000, estimate: 80_000, spent: 85_000, billed: 60_000 });
  const normal = () => openJob({ id: "Normal", contract: 50_000, estimate: 40_000, spent: 20_000, billed: 20_000 });

  it("lists it as needing an updated estimate, not as 100% complete", () => {
    const s = buildWipSchedule([overrun(), normal()], NOW);
    expect(s.inProgress.map((r) => r.jobId)).toEqual(["Normal"]);
    expect(s.notScheduled).toEqual([{ jobId: "Overrun", jobName: "Overrun", needs: "estimate_passed" }]);
    expect(NOT_SCHEDULED_NEED_TEXT.estimate_passed).toContain("costs have passed the estimate");
  });

  it("leaves it out of every total", () => {
    const s = buildWipSchedule([overrun(), normal()], NOW);
    // Only the normal job: 50% of $50,000 earned, $20,000 billed.
    expect(s.totals).toMatchObject({ contract: 50_000, costToDate: 20_000, earnedRevenue: 25_000, billedToDate: 20_000, underBilled: 5_000, overBilled: 0 });
    expect(buildWipSchedule([overrun()], NOW).totals).toMatchObject({ contract: 0, underBilled: 0, grossProfitToDate: 0 });
  });

  it("is kept out of anything that adds up WIP figures, and back on once a percent complete is entered", () => {
    expect(wipCountsInTotals(overrun(), NOW)).toBe(false);
    expect(wipCountsInTotals(normal(), NOW)).toBe(true);
    const entered = openJob({ id: "Overrun", contract: 100_000, estimate: 80_000, spent: 85_000, billed: 60_000, percent: 90 });
    expect(wipCountsInTotals(entered, NOW)).toBe(true);
    const [r] = buildWipSchedule([entered], NOW).inProgress;
    expect(r.percentComplete).toBeCloseTo(0.9);
    expect(r.estimatedTotalCost).toBeCloseTo(85_000 / 0.9);
    expect(r.overBilled - r.underBilled).toBeCloseTo(60_000 - 90_000);
  });
});

describe("WIP schedule: expected losses booked in full (C7)", () => {
  it("shows the whole expected loss in gross profit to date, with the rest as a provision", () => {
    // $100,000 contract, $120,000 estimated cost, $60,000 spent (50%), $50,000 billed.
    const f = openJob({ id: "Loss", contract: 100_000, estimate: 120_000, spent: 60_000, billed: 50_000 });
    const s = buildWipSchedule([f], NOW);
    expect(s.inProgress[0]).toMatchObject({
      estimatedTotalCost: 120_000,
      estimatedGrossProfit: -20_000,
      earnedRevenue: 50_000,
      provisionForLoss: 10_000,
      grossProfitToDate: -20_000,
    });
    expect(s.totals.provisionForLoss).toBe(10_000);
    expect(s.totals.grossProfitToDate).toBe(-20_000);
  });

  it("books no provision on a job expected to make money", () => {
    const f = openJob({ id: "Fine", contract: 100_000, estimate: 70_000, spent: 35_000, billed: 40_000 });
    expect(buildWipSchedule([f], NOW).inProgress[0]).toMatchObject({ provisionForLoss: 0, grossProfitToDate: 15_000 });
  });
});

describe("WIP schedule: a small entered percent complete (C8)", () => {
  it("doesn't divide cost to date by it", () => {
    // $30,000 of materials delivered on a job entered as 10% complete.
    const f = openJob({ id: "Early", contract: 100_000, estimate: 80_000, spent: 30_000, billed: 10_000, percent: 10 });
    expect(estimatedTotalCostOf(f)).toBe(80_000);
    const [r] = buildWipSchedule([f], NOW).inProgress;
    expect(r).toMatchObject({ estimatedTotalCost: 80_000, estimatedGrossProfit: 20_000, costToComplete: 50_000, provisionForLoss: 0 });
  });

  it("uses cost to date when that's larger than the estimate, and leaves it blank with no estimate", () => {
    const past = openJob({ id: "Past", contract: 100_000, estimate: 20_000, spent: 30_000, billed: 10_000, percent: 10 });
    expect(estimatedTotalCostOf(past)).toBe(30_000);
    const none = openJob({ id: "None", contract: 100_000, estimate: null, spent: 30_000, billed: 10_000, percent: 10 });
    expect(estimatedTotalCostOf(none)).toBeNull();
  });

  it("projects from an entered percent of 25% or more", () => {
    const f = openJob({ id: "Quarter", contract: 100_000, estimate: 80_000, spent: 30_000, billed: 10_000, percent: 25 });
    expect(estimatedTotalCostOf(f)).toBe(120_000);
  });

  it("lists a job under 25% whose cost has reached the estimate as needing an updated one, out of the totals", () => {
    // Estimated total cost would be cost to date: nothing left to spend and
    // $70,000 of estimated gross profit, beside a loss to date of $20,000.
    const past = openJob({ id: "Past", contract: 100_000, estimate: 20_000, spent: 30_000, billed: 10_000, percent: 10 });
    const at = openJob({ id: "At", contract: 100_000, estimate: 30_000, spent: 30_000, billed: 10_000, percent: 20 });
    const normal = openJob({ id: "Normal", contract: 50_000, estimate: 40_000, spent: 20_000, billed: 20_000 });
    const s = buildWipSchedule([past, at, normal], NOW);
    expect(s.inProgress.map((r) => r.jobId)).toEqual(["Normal"]);
    expect(s.notScheduled).toEqual([
      { jobId: "At", jobName: "At", needs: "estimate_passed" },
      { jobId: "Past", jobName: "Past", needs: "estimate_passed" },
    ]);
    expect(s.totals).toMatchObject({ contract: 50_000, costToDate: 20_000, underBilled: 5_000, estimatedTotalCost: 40_000, costToComplete: 20_000 });
    expect(wipCountsInTotals(past, NOW)).toBe(false);
    expect(wipCountsInTotals(at, NOW)).toBe(false);
    // Still on the schedule from 25%, projected from the percent.
    const quarter = openJob({ id: "Quarter", contract: 100_000, estimate: 20_000, spent: 30_000, billed: 10_000, percent: 25 });
    expect(wipCountsInTotals(quarter, NOW)).toBe(true);
    expect(buildWipSchedule([quarter], NOW).inProgress[0]).toMatchObject({ estimatedTotalCost: 120_000, costToComplete: 90_000 });
  });

  it("lists a job under 25% with no cost estimate as needing one, and keeps the totals", () => {
    const none = openJob({ id: "None", contract: 100_000, estimate: null, spent: 30_000, billed: 10_000, percent: 10 });
    const tiny = openJob({ id: "Tiny", contract: 100_000, estimate: null, spent: 1_000, billed: 0, percent: 3 });
    const normal = openJob({ id: "Normal", contract: 50_000, estimate: 40_000, spent: 20_000, billed: 20_000 });
    const s = buildWipSchedule([none, tiny, normal], NOW);
    expect(s.inProgress.map((r) => r.jobId)).toEqual(["Normal"]);
    expect(s.notScheduled).toEqual([
      { jobId: "None", jobName: "None", needs: "progress" },
      { jobId: "Tiny", jobName: "Tiny", needs: "progress" },
    ]);
    expect(NOT_SCHEDULED_NEED_TEXT.progress).toBe("needs a cost estimate, or a percent complete of 25% or more");
    // Totals are there, not blanked by one job with no estimated total cost.
    expect(s.totals.estimatedTotalCost).toBe(40_000);
    expect(s.totals.estimatedGrossProfit).toBe(10_000);
    expect(s.totals.costToComplete).toBe(20_000);
    expect(wipCountsInTotals(none, NOW)).toBe(false);
    // With a cost estimate it goes on the schedule at the estimate.
    const withEstimate = openJob({ id: "None", contract: 100_000, estimate: 80_000, spent: 30_000, billed: 10_000, percent: 10 });
    expect(wipCountsInTotals(withEstimate, NOW)).toBe(true);
  });

  it("raises no unbilled work alert on a job the schedule leaves out for these reasons", () => {
    const underbilled = (j: JobFinancials) => computeNeedsAttentionForJob(j).some((i) => i.issueCode === "underbilled");
    // Entered as 20% complete on a $100,000 contract with nothing billed: $20,000 under billed on paper.
    expect(underbilled(openJob({ id: "NoEstimate", contract: 100_000, estimate: null, spent: 5_000, billed: 0, percent: 20 }))).toBe(false);
    expect(underbilled(openJob({ id: "Reached", contract: 100_000, estimate: 5_000, spent: 5_000, billed: 0, percent: 20 }))).toBe(false);
    expect(underbilled(openJob({ id: "Fine", contract: 100_000, estimate: 80_000, spent: 5_000, billed: 0, percent: 20 }))).toBe(true);
  });
});

describe("WIP schedule: billing past the contract (C13)", () => {
  it("keeps the contract and flags how far billing has gone past it", () => {
    const f = openJob({ id: "Extra", contract: 100_000, estimate: 95_000, spent: 90_000, billed: 120_000 });
    const [r] = buildWipSchedule([f], NOW).inProgress;
    expect(r.contract).toBe(100_000);
    expect(r.billedPastContract).toBe(20_000);
    const inside = openJob({ id: "Inside", contract: 100_000, estimate: 95_000, spent: 50_000, billed: 60_000 });
    expect(buildWipSchedule([inside], NOW).inProgress[0].billedPastContract).toBe(0);
  });
});

describe("WIP schedule: idle open jobs (C15h)", () => {
  it("leaves an idle job's old under billing out of the totals and names it", () => {
    const old = openJob({ id: "Old", contract: 50_000, estimate: 40_000, spent: 20_000, billed: 0, lastActivityDaysAgo: 400 });
    const live = openJob({ id: "Live", contract: 50_000, estimate: 40_000, spent: 20_000, billed: 20_000 });
    expect(isIdleOpenJob(old, NOW)).toBe(true);
    expect(wipCountsInTotals(old, NOW)).toBe(false);
    const s = buildWipSchedule([old, live], NOW);
    expect(s.inProgress.map((r) => r.jobId)).toEqual(["Live"]);
    expect(s.totals.underBilled).toBe(5_000);
    expect(s.idle).toEqual([{ jobId: "Old", jobName: "Old" }]);
    expect(s.notScheduled).toEqual([]);
  });

  it("keeps a new job with nothing posted yet on the schedule", () => {
    const fresh = openJob({ id: "Fresh", contract: 50_000, estimate: 40_000, spent: 0, billed: 0, createdDaysAgo: 3 });
    const undated = openJob({ id: "Undated", contract: 50_000, estimate: 40_000, spent: 0, billed: 0, createdDaysAgo: null });
    const s = buildWipSchedule([fresh, undated], NOW);
    expect(s.inProgress.map((r) => r.jobId)).toEqual(["Fresh", "Undated"]);
    expect(s.idle).toEqual([]);
  });
});
