import { describe, it, expect } from "vitest";
import { computeWeekOverWeek, renderWeekOverWeek } from "../weekOverWeek";
import { cleanDigestText, withoutOpenJobUnderspend } from "../digestText";
import type { ConnectionMetrics, JobMetrics } from "../profitability";

const LAST_WEEK = new Date("2026-09-14T00:00:00Z");

function job(
  id: string,
  name: string,
  revenue: number,
  cost: number,
  estimate: number | null,
  status = "open"
): JobMetrics {
  return {
    jobId: id,
    jobName: name,
    customerName: null,
    status,
    estimatedCost: estimate,
    actualCost: cost,
    estimatedRevenue: null,
    actualRevenue: revenue,
    costByCategory: {},
    marginPct: revenue > 0 ? (revenue - cost) / revenue : null,
    varianceVsEstimate: estimate == null ? null : cost - estimate,
    varianceVsEstimatePct: estimate ? (cost - estimate) / estimate : null,
    flags: [],
  };
}

function metrics(jobs: JobMetrics[]): ConnectionMetrics {
  return {
    connectionId: "c1",
    weekStarting: new Date("2026-09-21T00:00:00Z"),
    jobs,
    topConcerns: [],
    totals: { activeJobs: 0, totalActualCost: 0, totalActualRevenue: 0, blendedMarginPct: null },
    dataHealth: {} as ConnectionMetrics["dataHealth"],
  };
}

/** Stored snapshots come back from Postgres as JSON, dates and all. */
const asStored = (m: ConnectionMetrics) => JSON.parse(JSON.stringify(m));

describe("computeWeekOverWeek", () => {
  const before = metrics([
    job("tk", "Torres Kitchen Remodel", 42000, 28000, 23800),
    job("h3", "Harborview Unit 3 Kitchen", 13000, 10150, 10150),
    job("rk", "Ruiz Kitchen", 22000, 17350, 15100),
    job("rf", "Harborview Roof Replacement", 16400, 9000, 9600, "closed"),
    job("pl", "Harborview Unit 5 Punchlist", 2400, 0, null),
  ]);
  const after = metrics([
    job("tk", "Torres Kitchen Remodel", 42000, 30400, 23800),
    job("h3", "Harborview Unit 3 Kitchen", 13000, 11400, 10150),
    job("rk", "Ruiz Kitchen", 22000, 17350, 15100, "closed"),
    job("rf", "Harborview Roof Replacement", 16400, 9000, 9600, "closed"),
    job("pl", "Harborview Unit 5 Punchlist", 2400, 0, 2000),
    job("tb", "Torres Bath Remodel", 9000, 8000, 18000),
  ]);
  const report = computeWeekOverWeek({ weekStarting: LAST_WEEK, metrics: asStored(before) }, after);

  it("totals what moved across all jobs", () => {
    expect(report.revenueAdded).toBe(9000); // the new job's billing
    expect(report.costAdded).toBe(11650); // 2,400 + 1,250 + 8,000
    expect(report.marginBefore).toBeCloseTo((95800 - 64500) / 95800, 6);
    expect(report.marginAfter).toBeCloseTo((104800 - 76150) / 104800, 6);
  });

  it("finds each kind of change and counts the rest as unchanged", () => {
    const byId = Object.fromEntries(report.changes.map((c) => [c.jobId, c]));
    expect(byId.tk.costAdded).toBe(2400);
    expect(byId.rk.statusChange).toBe("completed");
    expect(byId.tb.isNew).toBe(true);
    expect(byId.pl.estimateBefore).toBeNull();
    expect(byId.pl.estimateAfter).toBe(2000);
    expect(byId.rf).toBeUndefined();
    expect(report.unchangedJobs).toBe(1);
  });

  it("flags a job only when it CROSSES the over-budget line", () => {
    const byId = Object.fromEntries(report.changes.map((c) => [c.jobId, c]));
    // Harborview Unit 3 was on budget and is now 12% over.
    expect(byId.h3.nowOverBudgetPct).toBeCloseTo(1250 / 10150, 6);
    // Torres Kitchen was already 18% over last week. More spend is news;
    // "went over budget" is not.
    expect(byId.tk.nowOverBudgetPct).toBeNull();
  });

  it("leads with the job that just went over budget, then completions, then dollars", () => {
    expect(report.changes.map((c) => c.jobId)).toEqual(["h3", "rk", "tb", "tk", "pl"]);
  });

  it("reports a job that disappeared from the sync", () => {
    const gone = computeWeekOverWeek(
      { weekStarting: LAST_WEEK, metrics: asStored(before) },
      metrics(after.jobs.filter((j) => j.jobId !== "rf"))
    );
    expect(gone.changes.find((c) => c.jobId === "rf")?.removed).toBe(true);
  });

  it("treats sub-dollar drift as no change", () => {
    const drift = metrics(before.jobs.map((j) => ({ ...j, actualCost: j.actualCost + 0.2 })));
    const r = computeWeekOverWeek({ weekStarting: LAST_WEEK, metrics: asStored(before) }, drift);
    expect(r.changes).toHaveLength(0);
    expect(r.unchangedJobs).toBe(5);
  });

  it("says there is nothing to compare on the first brief", () => {
    const r = computeWeekOverWeek(null, after);
    expect(r.noComparisonReason).toBe("first_brief");
    expect(r.changes).toHaveLength(0);
  });

  it("refuses to compare against a snapshot it cannot read", () => {
    const r = computeWeekOverWeek({ weekStarting: LAST_WEEK, metrics: { jobs: [{ nope: 1 }] } }, after);
    expect(r.noComparisonReason).toBe("unreadable_snapshot");
    expect(r.changes).toHaveLength(0);
  });
});

describe("renderWeekOverWeek", () => {
  it("renders the section a customer sees", () => {
    const before = metrics([
      job("h3", "Harborview Unit 3 Kitchen", 13000, 10150, 10150),
      job("rk", "Ruiz Kitchen", 22000, 17350, 15100),
    ]);
    const after = metrics([
      job("h3", "Harborview Unit 3 Kitchen", 13000, 11400, 10150),
      job("rk", "Ruiz Kitchen", 22000, 17350, 15100, "closed"),
    ]);
    const text = renderWeekOverWeek(
      computeWeekOverWeek({ weekStarting: LAST_WEEK, metrics: asStored(before) }, after)
    );

    expect(text).toContain("WHAT CHANGED SINCE THE BRIEF FOR THE WEEK OF SEP 14");
    expect(text).toContain("Across all jobs: $1,250 in new costs.");
    expect(text).toContain(
      "- Harborview Unit 3 Kitchen: $1,250 in new costs. Margin 21.9% to 12.3%. Now 12% over its estimate."
    );
    expect(text).toContain("- Ruiz Kitchen: Marked completed. Finished at 21.1% margin.");
    // House style: no em or en dashes anywhere in the section.
    expect(text).not.toMatch(/[–—]/);
  });

  it("says so plainly when nothing moved", () => {
    const m = metrics([job("a", "A", 1000, 500, null)]);
    const text = renderWeekOverWeek(computeWeekOverWeek({ weekStarting: LAST_WEEK, metrics: asStored(m) }, m));
    expect(text).toContain("Nothing changed on your jobs in QuickBooks since then.");
  });

  it("describes a reduction as a reduction", () => {
    const before = metrics([job("a", "Deck", 5000, 3000, null)]);
    const after = metrics([job("a", "Deck", 4500, 3000, null)]); // a credit memo
    const text = renderWeekOverWeek(
      computeWeekOverWeek({ weekStarting: LAST_WEEK, metrics: asStored(before) }, after)
    );
    expect(text).toContain("- Deck: Billing down $500.");
  });
});

describe("cleanDigestText", () => {
  it("removes a subject line and greeting the model wrote into the body", () => {
    expect(cleanDigestText("Subject: Week of Sept 14\n\nHi team,\nTorres Kitchen ran over.")).toBe(
      "Torres Kitchen ran over."
    );
  });

  it("replaces dashes used as punctuation", () => {
    expect(cleanDigestText("Torres Kitchen ran over – by $6,600 — again.")).toBe(
      "Torres Kitchen ran over, by $6,600, again."
    );
    expect(cleanDigestText("Jan–Mar")).toBe("Jan-Mar");
  });

  it("leaves ordinary text alone", () => {
    const text = "Torres Kitchen is 28% over budget.\n\nIt stayed profitable.";
    expect(cleanDigestText(text)).toBe(text);
  });
});

describe("withoutOpenJobUnderspend", () => {
  // Torres Bath from the real test brief: open, $8,000 spent of $11,500.
  const torresBath = job("tb", "Torres Bath Remodel", 9000, 8000, 11500);

  it("replaces an open job's negative variance with spend against the estimate", () => {
    const shaped = withoutOpenJobUnderspend(torresBath);
    expect(shaped.varianceVsEstimate).toBeNull();
    expect(shaped.varianceVsEstimatePct).toBeNull();
    expect(shaped.spentOfEstimatePct).toBeCloseTo(8000 / 11500, 6);
    expect(shaped.actualCost).toBe(8000); // the facts themselves are untouched
  });

  it("keeps variance on an open job that is already over its estimate", () => {
    const over = job("h3", "Harborview Unit 3 Kitchen", 13000, 11400, 10150);
    expect(withoutOpenJobUnderspend(over).varianceVsEstimate).toBe(1250);
  });

  it("keeps a completed job's underspend, which is a real result", () => {
    const roof = job("rf", "Harborview Roof Replacement", 16400, 9000, 9600, "closed");
    expect(withoutOpenJobUnderspend(roof).varianceVsEstimate).toBe(-600);
  });
});
