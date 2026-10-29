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
  // The real one adds inference_geo: "us" (src/lib/ai.ts); its own test covers that.
  inUs: (params: any) => params,
  // The real one reads the SDK's error shape (src/lib/ai.ts); these tests only throw plain errors.
  aiFailureKind: (err: any) => (/timed out/i.test(err?.message ?? "") ? "timeout" : [400, 401, 403, 404, 413, 422].includes(err?.status) ? "refused" : "other"),
  aiErrorText: (err: any) => String(err?.message ?? err),
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

// Found in the audit of Oct 19, 2026: correct sentences taken out, and the
// sentence after one taken out left describing the wrong job. More in
// audit1019Brief.test.ts.
// The test company's preview of Oct 29, 2026, word for word, after thinking
// was turned off. Every figure in it was right, but it called MX04 "not a
// projected loss" (its cost estimate is $10,000 above its contract; its
// forecast was held back because nothing had been entered on it for 38
// days), said MX05 through MX17 had no estimates (MX06 has one), and told
// the owner to "Give the owner the plain numbers".
const OCT_29 = `MX02 Past Estimate needs a look first. It's billed $24,000 against $34,000 in actual costs, which is $4,000 over its $30,000 estimate. Give the owner the plain numbers: $34,000 spent, $24,000 billed, and it's worth checking why billing hasn't caught up to the costs on the job.

MX01 Early Materials is also one to watch: it's 40% complete with $18,000 spent of a $45,000 estimate, but only $6,000 has been billed against $60,000 in contract value, putting it $18,000 behind on billing. Worth confirming invoices are going out as work progresses.

On the closed side, Torres Kitchen Remodel finished at a 27.6% margin, so it stayed profitable overall, but it ran $6,600 over its $23,800 estimate (about 28% over). Torres Bath Remodel, the other Torres job, is 66% complete with $7,596 spent of its $11,500 estimate and is currently $2,890 behind on billing relative to work done.

MX04 Expected Loss is halfway through its estimate, with $30,000 spent of $60,000 and billing matching work done so far (no over or under billing). Its -20% margin to date reflects billing timing at this stage, not a projected loss, since there's no forecast available for this job.

The rest of the Oakridge test jobs (MX05 through MX17) have no estimates on file, so spend and billing on each can only be reported as raw dollars: for example MX05 Overdue Invoice has $3,000 in costs against $8,000 billed.`;

const OCT_29_JOBS: SummaryJobFacts[] = [
  ...JOBS.map((j) => (j.jobName === "MX04 Expected Loss" ? { ...j, forecastMarginPct: null } : j)),
  ...["MX05 Overdue Invoice", "MX07 Parent Match", "MX08 Refund Check", "MX09 Supplier Refund", "MX10 Construction in Progress", "MX11 Inventory Relief", "MX12 Deposit Income", "MX13 Journal Income", "MX14 Vendor Credit", "MX15 Discount Invoice", "MX16 Duplicate Expenses", "MX17 Crew Time"].map(
    (jobName): SummaryJobFacts => ({ jobName, status: "open", marginPct: 0.2, forecastMarginPct: null })
  ),
];
const oct29: SummaryFacts = { jobs: OCT_29_JOBS, comparison: "skipped" };

describe("the preview of Oct 29: how a job will finish, ranges of jobs, and who it's written to", () => {
  it("finds the three mistakes in the Oct 29 preview, and nothing else", () => {
    expect(brief(oct29, OCT_29)).toEqual([
      ["owner_in_third_person", null, "Give the owner the plain numbers: $34,00"],
      ["outcome_without_forecast", "MX04 Expected Loss", "Its -20% margin to date reflects billing"],
      ["range_of_jobs", null, "The rest of the Oakridge test jobs (MX05"],
    ]);
  });

  it("says why, naming the jobs a range takes in", () => {
    const range = findSummaryProblems(OCT_29, oct29).find((p) => p.rule === "range_of_jobs")!;
    expect(range.reason).toBe(
      "It describes jobs as a range (MX05 to MX17), which takes in MX06 Idle Job, MX07 Parent Match, MX08 Refund Check and 8 more as well, and what it says may not be true of them. Name each job you mean."
    );
  });

  it("catches a claim about how an open job without a forecast will finish, said either way", () => {
    for (const text of [
      "MX02 Past Estimate is not a projected loss.",
      "MX02 Past Estimate isn't heading for a loss.",
      "MX02 Past Estimate won't lose money.",
      "MX02 Past Estimate will still finish profitable.",
      "MX02 Past Estimate is on course for a profit.",
      "MX02 Past Estimate is set to lose $4,000.",
      "MX02 Past Estimate has an expected loss of $4,000.",
      "MX02 Past Estimate isn't expected to lose money.",
      "MX02 Past Estimate is not projected to finish in the red.",
    ]) {
      // Caught by this rule, or by the forecast or loss rule when those words are in it.
      const rules = brief(oct29, text).map((p) => p[0]);
      expect({ text, caught: rules.some((r) => ["outcome_without_forecast", "forecast_without_forecast", "loss_without_loss"].includes(String(r))) }).toEqual({ text, caught: true });
    }
  });

  it("allows it on a job with a firm forecast, about a finished job, and the present tense the prompt asks for", () => {
    for (const text of [
      "MX03 Billed Past Contract is on track to finish profitable.",
      "MX03 Billed Past Contract won't lose money on its 28.4% forecast.",
      "Torres Kitchen Remodel stayed profitable.",
      "MX02 Past Estimate isn't losing money: it has $34,000 spent and $24,000 billed.",
      "There's no forecast for MX04 Expected Loss yet.",
      "MX04 Expected Loss has $30,000 spent of a $60,000 estimate.",
    ]) {
      expect({ text, problems: brief(oct29, text) }).toEqual({ text, problems: [] });
    }
  });

  it("catches a range only when it takes in a job it doesn't name", () => {
    expect(brief(oct29, "MX05 Overdue Invoice through MX17 Crew Time have no estimates.").map((p) => p[0])).toEqual(["range_of_jobs"]);
    expect(brief(oct29, "MX05 to MX07 have no estimates.").map((p) => p[0])).toEqual(["range_of_jobs"]);
    expect(brief(oct29, "MX01 Early Materials and MX02 Past Estimate are both behind on billing.")).toEqual([]);
    expect(brief(oct29, "MX01 to MX02 both need invoices.")).toEqual([]);
  });

  it("catches the owner talked about as someone else, not a homeowner or a property owner", () => {
    expect(brief(oct29, "Tell the owner that MX02 Past Estimate needs a look.").map((p) => p[0])).toEqual(["owner_in_third_person"]);
    expect(brief(oct29, "The homeowner on MX02 Past Estimate hasn't been billed since September.")).toEqual([]);
    expect(brief(oct29, "The property owner on MX02 Past Estimate hasn't been billed since September.")).toEqual([]);
  });

  // From an independent review of the rules above: sentences a good summary
  // has that a first version took out, and claims it let through.
  it("leaves doubt, a missing forecast margin, and plain talk about invoices and costs alone", () => {
    for (const text of [
      "It's too early to say whether MX01 Early Materials will make a profit.",
      "We can't tell yet whether MX02 Past Estimate will finish profitable.",
      "MX01 Early Materials isn't far enough along to say whether it will lose money.",
      "There's no forecast for MX04 Expected Loss yet, so it's too early to say whether it will finish at a loss or a profit.",
      "MX04 Expected Loss doesn't have a forecast margin yet.",
      "There's no forecast margin for MX02 Past Estimate yet.",
      "Getting the next invoice out on MX01 Early Materials would make a big dent in the $18,000 billing gap.",
      "Torres Bath Remodel is $2,890 behind on billing, which will close with the next progress invoice.",
      "MX02 Past Estimate will finish above its $30,000 estimate, since $34,000 is already spent.",
      "Costs were moved from MX05 Overdue Invoice to MX07 Parent Match.",
      "MX02 Past Estimate is waiting on the owner's approval of a change order.",
      "MX02 Past Estimate is with the owner of the building for sign-off.",
    ]) {
      expect({ text, problems: brief(oct29, text) }).toEqual({ text, problems: [] });
    }
  });

  it("catches other ways of saying how an open job without a forecast will finish", () => {
    for (const text of [
      "MX02 Past Estimate should still finish profitable.",
      "MX02 Past Estimate could lose $4,000.",
      "MX02 Past Estimate stands to lose $4,000.",
      "MX02 Past Estimate'll still turn a profit.",
      "MX02 Past Estimate will not lose money.",
      "MX02 Past Estimate will be in the black.",
      "MX02 Past Estimate will show a profit.",
      "MX02 Past Estimate will probably break even.",
      "MX02 Past Estimate is on pace to lose money.",
      "MX02 Past Estimate is trending toward a loss.",
      "MX02 Past Estimate is unlikely to finish profitable.",
      "MX02 Past Estimate has expected profits of $4,000.",
    ]) {
      const rules = brief(oct29, text).map((p) => String(p[0]));
      expect({ text, caught: rules.some((r) => ["outcome_without_forecast", "forecast_without_forecast", "loss_without_loss"].includes(r)) }).toEqual({ text, caught: true });
    }
  });

  it("says a job it names has no estimate only when that job has none", () => {
    const ESTIMATES: Record<string, number> = { "MX01 Early Materials": 45000, "MX02 Past Estimate": 30000, "MX04 Expected Loss": 60000, "MX06 Idle Job": 16000 };
    const withEstimates: SummaryFacts = {
      jobs: [
        ...OCT_29_JOBS.map((j) => ({ ...j, estimatedCost: ESTIMATES[j.jobName] ?? null })),
        { jobName: "Lakeside Bath", status: "open", marginPct: 0.1, estimatedCost: 9000, estimateSetFromTargetMargin: true },
      ],
      comparison: "skipped",
    };
    for (const text of [
      "MX06 Idle Job has no estimate on file.",
      "MX06 Idle Job doesn't have an estimate on file.",
      "MX06 Idle Job does not have a cost estimate.",
      "MX06 Idle Job lacks an estimate.",
      "MX06 Idle Job has no estimated cost.",
      "MX06 Idle Job's estimate isn't on file.",
    ]) {
      expect({ text, rules: brief(withEstimates, text).map((p) => p[0]) }).toEqual({ text, rules: ["estimate_said_missing"] });
    }
    // True, or not about a job that has one: from the second review.
    for (const text of [
      "MX05 Overdue Invoice has no estimate on file.",
      "MX01 Early Materials has no estimate problems.",
      "There have been no estimate changes on MX06 Idle Job since the last brief.",
      "MX06 Idle Job had no estimate last week; a $16,000 one was added since.",
      "MX06 Idle Job's missing estimate has now been entered at $16,000.",
      "MX06 Idle Job isn't missing an estimate.",
      "MX06 Idle Job's estimate is on file.",
      "MX06 Idle Job has $4,000 spent of a $16,000 estimate. The rest of the jobs have no estimates on file.",
      "MX06 Idle Job has $4,000 spent of a $16,000 estimate. Three open jobs have no estimate on file.",
      "All the other jobs are billed ahead of the work, and MX05 Overdue Invoice has no estimate.",
      // An estimate worked out from the target margin isn't one the contractor priced.
      "Lakeside Bath has no estimate on file.",
    ]) {
      expect({ text, problems: brief(withEstimates, text) }).toEqual({ text, problems: [] });
    }
  });

  it("takes out just those three sentences when the rewrite doesn't fix them", () => {
    const left = withoutSentences(
      OCT_29,
      findSummaryProblems(OCT_29, oct29).map((p) => p.sentence),
      OCT_29_JOBS
    );
    expect(left).not.toContain("projected loss");
    expect(left).not.toContain("the owner");
    expect(left).not.toContain("MX05 through MX17");
    expect(left).toContain("MX04 Expected Loss is halfway through its estimate");
    expect(left).toContain("MX02 Past Estimate needs a look first.");
  });
});

describe("job names come first", () => {
  const withWarranty: SummaryFacts = { jobs: [...JOBS, { jobName: "Warranty", status: "completed", marginPct: 0.1 }], comparison: "skipped" };

  it("pins a phrase on the clause's subject, never on a job named inside it or earlier in the sentence", () => {
    expect(brief(withWarranty, "MX04 Expected Loss picked up $2,000 of warranty costs and is forecast to finish at -20%.")).toEqual([]);
    expect(brief(skipped, "Torres Bath Remodel has $2,890 not yet billed, and the forecast for MX03 Billed Past Contract is a 28.4% margin.")).toEqual([]);
  });

  it("takes out the sentence after one taken out when it names no job and refers back", () => {
    const text = "MX02 Past Estimate is forecast to finish at -41.7%. It has $34,000 spent against a $30,000 estimate. MX04 Expected Loss is forecast to finish at -20%.";
    const problems = findSummaryProblems(text, skipped);
    expect(problems.map((p) => p.sentence)).toEqual(["MX02 Past Estimate is forecast to finish at -41.7%."]);
    expect(withoutSentences(text, problems.map((p) => p.sentence), JOBS)).toBe("MX04 Expected Loss is forecast to finish at -20%.");
  });

  it("keeps the Sep 28 summary's good sentences, and nothing that would read as about another job", () => {
    const left = withoutSentences(SEP_28, findSummaryProblems(SEP_28, skipped).map((p) => p.sentence), JOBS);
    // "The margin number there ..." went with the MX01 sentence before it.
    expect(summarySentences(left, JOBS).map((p) => p.length)).toEqual([1, 1, 2]);
    expect(left.startsWith("MX02 Past Estimate is the one to look at first.\n\nMX04 Expected Loss is on track to close")).toBe(true);
  });
});

// From the review of the Oct 19 fixes.
describe("a phrase in a clause that names no job", () => {
  const facts = (jobs: SummaryJobFacts[]): SummaryFacts => ({ jobs, comparison: "changes" });
  const smith = (forecastMarginPct: number | null): SummaryJobFacts => ({ jobName: "Smith Kitchen", status: "open", marginPct: 0.2, forecastMarginPct });
  const torres = (forecastMarginPct: number | null): SummaryJobFacts => ({ jobName: "Torres Bath", status: "open", marginPct: 0.2, forecastMarginPct });

  it("is about the job named last before it, not the first", () => {
    for (const s of [
      "Smith Kitchen is running well ahead of Torres Bath, which is forecast to finish at 2%.",
      "Smith Kitchen is running well ahead of Torres Bath which is forecast to finish at 2%.",
    ]) {
      expect(brief(facts([smith(0.2), torres(null)]), s)).toEqual([["forecast_without_forecast", "Torres Bath", s.slice(0, 40)]]);
      // The other way round the sentence is true, and stays.
      expect(brief(facts([smith(null), torres(0.02)]), s)).toEqual([]);
    }
    const acme = (marginPct: number): SummaryJobFacts => ({ jobName: "Acme Supply Co.", status: "completed", marginPct });
    const done = (marginPct: number): SummaryJobFacts => ({ jobName: "Smith Kitchen", status: "completed", marginPct });
    const s = "Smith Kitchen did better than Acme Supply Co., which lost money.";
    expect(brief(facts([done(-0.05), acme(0.3)]), s)).toEqual([["loss_without_loss", "Acme Supply Co.", s.slice(0, 40)]]);
    expect(brief(facts([done(0.3), acme(-0.05)]), s)).toEqual([]);
  });

  it("is about the previous clause's subject when it starts with 'it' or plainly, not a job named later in it", () => {
    const s = "Smith Kitchen has spent more than Torres Bath so far, and it's forecast to finish at 5%.";
    expect(brief(facts([smith(null), torres(0.05)]), s)).toEqual([["forecast_without_forecast", "Smith Kitchen", s.slice(0, 40)]]);
    // The other way round the sentence is true, and stays.
    expect(brief(facts([smith(0.05), torres(null)]), s)).toEqual([]);
    const plain = "Smith Kitchen has spent more than Torres Bath so far, and is forecast to finish at 5%.";
    expect(brief(facts([smith(null), torres(0.05)]), plain).map((p) => p[1])).toEqual(["Smith Kitchen"]);
    expect(brief(facts([smith(0.05), torres(null)]), plain)).toEqual([]);
  });

  it("is about each job when the last thing named is a pair of them", () => {
    const s = "Ruiz Kitchen Remodel and Harborview closed over estimate, and both lost money.";
    expect(brief(skipped, s)).toEqual([["loss_without_loss", "Ruiz Kitchen Remodel", s.slice(0, 40)]]);
  });
});

describe("a sentence that ends in an abbreviation or an initial", () => {
  const jobs: SummaryJobFacts[] = [
    { jobName: "Harborview Building C", status: "open", marginPct: 0.3, forecastMarginPct: 0.25 },
    { jobName: "Torres Bath", status: "open", marginPct: 0.2, forecastMarginPct: null },
  ];
  const facts: SummaryFacts = { jobs, comparison: "changes" };
  const claim = "Torres Bath is forecast to finish at 8%.";

  it("ends where a job's name ends at the full stop, or a job's name or an opening word starts the next one", () => {
    for (const first of ["Costs are highest on Harborview Building C.", "The last of the work wrapped up on Elm St."]) {
      expect(summarySentences(`${first} ${claim}`, jobs)).toEqual([[first, claim]]);
      expect(findSummaryProblems(`${first} ${claim}`, facts).map((p) => p.sentence)).toEqual([claim]);
      expect(withoutSentences(`${first} ${claim}`, [claim], jobs)).toBe(first);
    }
    expect(summarySentences("Crews finished on Elm St. The forecast is next.")).toEqual([["Crews finished on Elm St.", "The forecast is next."]]);
  });

  it("still doesn't end inside a name, after an initial, or before a number", () => {
    expect(summarySentences("J. Smith Bath has $2,000 spent. 1418 Elm St. Remodel is next. Smith Inc. paid it. No. 5 is last.")).toEqual([
      ["J. Smith Bath has $2,000 spent.", "1418 Elm St. Remodel is next.", "Smith Inc. paid it.", "No. 5 is last."],
    ]);
  });
});

describe("a job code that looks like a year or a month", () => {
  it("isn't taken for the job when it's a bare year, but a numbered code like 2024-07 is", () => {
    const jobs: SummaryJobFacts[] = [
      { jobName: "2025 Warranty Work", status: "completed", marginPct: 0.1 },
      { jobName: "2024-07 Deck", status: "completed", marginPct: 0.1 },
      { jobName: "Torres Bath", status: "open", marginPct: 0.2, forecastMarginPct: null },
    ];
    const s = "Torres Bath, open since 2025, is forecast to lose money.";
    expect(brief({ jobs, comparison: "changes" }, s)).toEqual([
      ["forecast_without_forecast", "Torres Bath", s.slice(0, 40)],
      ["loss_without_loss", "Torres Bath", s.slice(0, 40)],
    ]);
    expect(brief({ jobs, comparison: "changes" }, "2024-07 lost money on the railing.")).toEqual([["loss_without_loss", "2024-07 Deck", "2024-07 lost money on the railing."]]);
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
  briefDataHealth: { overallConfidence: "high", jobsMissingEstimates: [], jobsMissingCosts: [], untaggedJobCostCount: 0, timeEntriesWithoutPayRate: 0, possibleDuplicates: [], idleOpenJobs: [] },
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
