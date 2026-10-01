import { describe, it, expect, beforeEach, vi } from "vitest";

// The check on the AI-written part of the Weekly Profit Brief: the rules
// the prompt asks for, checked on what actually came back, with one
// rewrite and then sentence removal. Built after the test company's brief
// of Sep 28, 2026 called billing-timing figures forecasts and an open job
// "losing money", and the preview of Oct 1 still closed with "Nothing
// changed since the last brief" in a week nothing was compared.

const ai = {
  replies: [] as (string | Error | { cutOff: true })[],
  calls: [] as any[],
};
vi.mock("@/lib/ai", () => ({
  AI_MODEL: "test-model",
  aiClient: () => ({
    messages: {
      create: async (params: any) => {
        ai.calls.push(params);
        const next = ai.replies.shift() ?? "MX04 Expected Loss has $30,000 spent against a $60,000 estimate.";
        if (next instanceof Error) throw next;
        if (typeof next === "object") return { stop_reason: "max_tokens", content: [{ type: "text", text: "cut off" }] };
        return { stop_reason: "end_turn", content: [{ type: "text", text: next }] };
      },
    },
  }),
}));
vi.mock("@/lib/profitability", () => ({ computeConnectionMetrics: async () => null }));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/opportunityData", () => ({ getOpportunityData: async () => null }));

import { findSummaryProblems, withoutSentences, summarySentences, type SummaryFacts, type SummaryJobFacts } from "../digestText";
import { generateWeeklyDigest, rewriteRequest } from "../digest";

// The test company as the brief now sees it (forecasts only where firm).
const JOBS: SummaryJobFacts[] = [
  { jobName: "MX01 Early Materials", status: "open", marginPct: -2, forecastMarginPct: null },
  { jobName: "MX02 Past Estimate", status: "open", marginPct: -0.4167, forecastMarginPct: null },
  { jobName: "MX03 Billed Past Contract", status: "open", marginPct: 0.373, forecastMarginPct: 0.284 },
  { jobName: "MX04 Expected Loss", status: "open", marginPct: -0.2, forecastMarginPct: -0.2 },
  { jobName: "MX06 Idle Job", status: "open", marginPct: 0.3, forecastMarginPct: null },
  { jobName: "Torres Bath Remodel", status: "open", marginPct: 0.2, forecastMarginPct: null },
  { jobName: "Torres Kitchen Remodel", status: "completed", marginPct: 0.276 },
  { jobName: "Ruiz Kitchen Remodel", status: "completed", marginPct: 0.41 },
  { jobName: "Harborview Unit 3 Kitchen", status: "completed", marginPct: 0.4 },
  { jobName: "Harborview", status: "completed", marginPct: -0.05 },
  { jobName: "Lakeside Deck", status: "completed", marginPct: 0.1, estimateSetFromTargetMargin: true },
];
const skipped: SummaryFacts = { jobs: JOBS, comparison: "skipped" };

// Word for word from the screenshots.
const SEP_28 = `MX02 Past Estimate is the one to look at first. It's forecast to finish at a negative 41.7% margin, with $34,000 spent against a $30,000 estimate (13.3% over) and actual cost now ahead of actual revenue. That's a job losing money, not just a job running hot, and it's worth digging into before more cost lands on it.

MX01 Early Materials is a different kind of flag: it's forecasting a negative 200% margin, with only $6,000 billed against $18,000 spent so far (40% complete) and work running $18,000 ahead of billing. The margin number there is really a billing-timing problem, since cost has outpaced invoicing by a wide margin, but it's worth confirming invoices are going out as work progresses.

MX04 Expected Loss is on track to close at a negative 20% margin, with $30,000 spent against a $50,000 estimate and revenue and cost even on billing. Torres Bath Remodel, by contrast, is in good shape: 66% complete, forecasting a 15.6% margin, with $2,890 of work done that hasn't been billed yet.

Among closed jobs, Torres Kitchen Remodel ran $6,600 over its $23,800 estimate (27.7%) but still closed at a 27.6% margin, so it went over budget and stayed profitable. Ruiz Kitchen Remodel and Harborview Unit 3 Kitchen also closed over estimate (14.9% and 12.3% respectively) while holding margins above 39%.

This brief can't be compared to last week because the margin calculation basis changed to include labor burden, so treat the figures above as the new baseline going forward.`;

const OCT_1 = `MX04 Expected Loss is the one to watch. It's half spent against a $60,000 estimate, with $30,000 in costs and $25,000 billed so far, and it's forecasting a margin of negative 20 percent. That's a job on track to lose money unless something changes on scope or billing.

MX02 Past Estimate has already gone over its budget: it cost $34,000 against a $30,000 estimate, 13.3 percent over, and since it's billed $24,000 against $34,000 spent, the shortfall is showing up now rather than later. MX01 Early Materials is also worth a look: it's billed only $6,000 against $18,000 spent so far (40 percent complete on a $45,000 estimate), so the work is well ahead of the billing.

On the closed jobs, Torres Kitchen Remodel finished $6,600 over its $23,800 estimate (27.7 percent over) but still closed at a 27.6 percent margin, so it stayed profitable despite the overrun. Ruiz Kitchen Remodel and Harborview Unit 3 Kitchen also finished over their estimates, by $2,250 and $1,250 respectively, and both closed profitably as well.

Torres Bath Remodel is progressing normally: 66 percent complete, $7,596.28 spent of an $11,500 estimate, with billing $2,890 behind the work done so far.

Nothing changed since the last brief because the comparison basis shifted this week, so there's nothing new to flag beyond the job-to-date picture above.`;

const brief = (facts: SummaryFacts, text: string) => findSummaryProblems(text, facts).map((p) => [p.rule, p.jobName ?? null, p.sentence.slice(0, 40)]);

describe("checking the written summary", () => {
  it("finds every mistake in the Sep 28 summary, and nothing else", () => {
    expect(brief(skipped, SEP_28)).toEqual([
      ["forecast_without_forecast", "MX02 Past Estimate", "It's forecast to finish at a negative 41"],
      ["loss_without_loss", "MX02 Past Estimate", "That's a job losing money, not just a jo"],
      ["forecast_without_forecast", "MX01 Early Materials", "MX01 Early Materials is a different kind"],
      ["forecast_without_forecast", "Torres Bath Remodel", "Torres Bath Remodel, by contrast, is in "],
      ["comparison_skipped", null, "This brief can't be compared to last wee"],
    ]);
  });

  it("finds only the closing line in the Oct 1 preview", () => {
    expect(brief(skipped, OCT_1)).toEqual([["comparison_skipped", null, "Nothing changed since the last brief bec"]]);
  });

  it("allows a forecast and a loss on a job with a firm forecast below zero", () => {
    expect(brief(skipped, "MX04 Expected Loss is forecast to finish at -20%. It's on track to lose money.")).toEqual([]);
    expect(brief(skipped, "MX03 Billed Past Contract is on track for a 28.4% margin.")).toEqual([]);
  });

  it("reads a negation before the phrase", () => {
    expect(brief(skipped, "MX02 Past Estimate has no firm forecast yet. It's too early for a forecast on MX01 Early Materials.")).toEqual([]);
    expect(brief(skipped, "Ruiz Kitchen Remodel didn't lose money.")).toEqual([]);
    expect(brief(skipped, "MX02 Past Estimate isn't done, and it's forecasting a loss.")).toEqual([
      ["forecast_without_forecast", "MX02 Past Estimate", "MX02 Past Estimate isn't done, and it's "],
    ]);
  });

  it("names a job by its code alone, and finds the job named after the phrase", () => {
    expect(brief(skipped, "MX02 is forecasting a negative margin.")).toEqual([["forecast_without_forecast", "MX02 Past Estimate", "MX02 is forecasting a negative margin."]]);
    expect(brief(skipped, "Forecasting a 15.6% margin, Torres Bath Remodel looks fine.")).toEqual([
      ["forecast_without_forecast", "Torres Bath Remodel", "Forecasting a 15.6% margin, Torres Bath "],
    ]);
  });

  it("takes the longest name where two overlap", () => {
    // "Harborview" alone is a different job, one that did lose money.
    expect(brief(skipped, "Harborview Unit 3 Kitchen lost money.")).toEqual([["loss_without_loss", "Harborview Unit 3 Kitchen", "Harborview Unit 3 Kitchen lost money."]]);
    expect(brief(skipped, "Harborview lost money.")).toEqual([]);
  });

  it("calls no finished job a loss when it made money, and no open job under budget", () => {
    expect(brief(skipped, "Torres Kitchen Remodel lost money on the overrun.")[0][0]).toBe("loss_without_loss");
    expect(brief(skipped, "MX06 Idle Job is $3,000 under its estimate so far.")[0][0]).toBe("open_job_under_budget");
    expect(brief(skipped, "Ruiz Kitchen Remodel came in under budget.")).toEqual([]);
    expect(brief(skipped, "Torres Bath Remodel has spent $7,596 of an $11,500 estimate.")).toEqual([]);
  });

  it("never calls an estimate set from the target margin overrun", () => {
    expect(brief(skipped, "Lakeside Deck ran $2,000 over its estimate.")[0][0]).toBe("target_estimate_overrun");
    expect(brief(skipped, "Lakeside Deck cost more than the target margin allows.")).toEqual([]);
    expect(brief(skipped, "Torres Kitchen Remodel ran $6,600 over its $23,800 estimate.")).toEqual([]);
  });

  it("says nothing about the comparison when there wasn't one, and never 'nothing changed' when something did", () => {
    expect(brief(skipped, "By comparison, MX03 Billed Past Contract is billed ahead of its work.")).toEqual([]);
    const changes: SummaryFacts = { jobs: JOBS, comparison: "changes" };
    const none: SummaryFacts = { jobs: JOBS, comparison: "no_changes" };
    expect(brief(changes, "Nothing changed on the open jobs this week.")[0][0]).toBe("nothing_changed");
    expect(brief(none, "Nothing changed on the open jobs this week.")).toEqual([]);
    expect(brief(changes, "The comparison above shows new costs on MX04 Expected Loss.")).toEqual([]);
  });

  it("takes sentences out and keeps the paragraphs, and leaves text alone with nothing to take out", () => {
    const text = "One. Two.\n\nThree.";
    expect(withoutSentences(text, ["Two."])).toBe("One.\n\nThree.");
    expect(withoutSentences(text, ["Three."])).toBe("One. Two.");
    expect(withoutSentences(text, [])).toBe(text);
    expect(summarySentences("It cost $7,596.28 to date. Next one.")).toEqual([["It cost $7,596.28 to date.", "Next one."]]);
  });
});

// --- In the brief itself -----------------------------------------------

const job = (jobName: string, status: string, marginPct: number, forecastMarginPct: number | null) => ({
  jobId: jobName, jobName, status, marginPct, forecastMarginPct,
  estimatedCost: 30_000, actualCost: 34_000, varianceVsEstimate: 4_000, varianceVsEstimatePct: 0.133,
});
const metrics = {
  weekStarting: new Date("2026-09-28T00:00:00Z"),
  briefJobIds: ["MX02 Past Estimate", "MX04 Expected Loss"],
  jobs: [job("MX02 Past Estimate", "open", -0.4167, null), job("MX04 Expected Loss", "open", -0.2, -0.2)],
  topConcerns: [],
  totals: {},
  briefDataHealth: { overallConfidence: "high", jobsMissingEstimates: [], jobsMissingCosts: [], untaggedJobCostCount: 0, timeEntriesWithoutPayRate: 0, possibleDuplicates: [] },
};
const skippedWeek = { noComparisonReason: "basis_changed", changes: [] } as any;
const GOOD = "MX04 Expected Loss is forecast to finish at a negative 20% margin.\n\nMX02 Past Estimate has $34,000 spent against a $30,000 estimate.";
const BAD = `${GOOD} It's forecast to finish at a negative 41.7% margin.\n\nNothing changed since the last brief.`;
const write = () => generateWeeklyDigest(metrics as any, "Acme", skippedWeek, Date.now() + 200_000);

describe("the brief's summary, checked before it's sent", () => {
  beforeEach(() => {
    ai.replies = [];
    ai.calls = [];
  });

  it("sends a summary that breaks no rule as written, with one request", async () => {
    ai.replies = [GOOD];
    expect(await write()).toBe(GOOD);
    expect(ai.calls).toHaveLength(1);
  });

  it("asks once for a rewrite, pointing at each sentence and what's wrong, and uses it", async () => {
    ai.replies = [BAD, GOOD];
    expect(await write()).toBe(GOOD);
    expect(ai.calls).toHaveLength(2);
    const turns = ai.calls[1].messages;
    expect(turns.map((t: any) => t.role)).toEqual(["user", "assistant", "user"]);
    expect(turns[1].content).toBe(BAD);
    expect(turns[2].content).toContain(`- "It's forecast to finish at a negative 41.7% margin." MX02 Past Estimate has no forecastMarginPct`);
    expect(turns[2].content).toContain(`- "Nothing changed since the last brief." There was no comparison`);
  });

  it("takes out what still breaks a rule after the rewrite", async () => {
    ai.replies = [BAD, BAD];
    expect(await write()).toBe(GOOD);
    expect(ai.calls).toHaveLength(2);
  });

  it("keeps the first draft, minus its bad sentences, when the rewrite fails or is cut off", async () => {
    ai.replies = [BAD, new Error("overloaded")];
    expect(await write()).toBe(GOOD);
    ai.replies = [BAD, { cutOff: true }];
    expect(await write()).toBe(GOOD);
  });

  it("keeps whichever draft breaks fewer rules", async () => {
    const worse = `${BAD} That's a job losing money, MX02 Past Estimate.`;
    ai.replies = [BAD, worse];
    expect(await write()).toBe(GOOD);
  });

  it("goes without the summary when nothing in it is left", async () => {
    ai.replies = ["Nothing changed since the last brief.", "Nothing changed since the last brief."];
    const err = await write().catch((e) => e);
    expect(err instanceof Error && err.message).toBe("Every sentence of the written summary broke the brief's rules, so it was left out.");
  });

  it("builds the rewrite request from the problems", () => {
    const text = rewriteRequest(findSummaryProblems("MX02 Past Estimate is forecasting a loss.", skipped));
    expect(text.split("\n")[0]).toBe("Some sentences in your summary break the rules:");
    expect(text).toContain("Reply with the summary only.");
  });
});
