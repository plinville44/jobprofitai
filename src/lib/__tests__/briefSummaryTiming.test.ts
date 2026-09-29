import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "fs";
import path from "path";

// The Weekly Profit Brief's written summary and the run's deadline: a
// summary lost to timing defers the company to the next run instead of
// sending the brief without it, a real AI failure still sends without it,
// and a retried send reuses the summary already written.

const ai = {
  calls: [] as { timeoutMs: number; retries: number }[],
  fail: null as Error | null,
  lastParams: null as any,
};
vi.mock("@/lib/ai", () => ({
  AI_MODEL: "test-model",
  aiClient: (timeoutMs: number, retries: number) => ({
    messages: {
      create: async (params: any) => {
        ai.calls.push({ timeoutMs, retries });
        ai.lastParams = params;
        if (ai.fail) throw ai.fail;
        return { stop_reason: "end_turn", content: [{ type: "text", text: "Torres Kitchen is over its estimate." }] };
      },
    },
  }),
}));

const metrics = {
  weekStarting: new Date("2026-09-21T00:00:00Z"),
  briefJobIds: [],
  jobs: [],
  topConcerns: [],
  totals: {},
  briefDataHealth: {
    overallConfidence: "high",
    jobsMissingEstimates: [],
    jobsMissingCosts: [],
    untaggedJobCostCount: 0,
    timeEntriesWithoutPayRate: 0,
    possibleDuplicates: [],
  },
};
vi.mock("@/lib/profitability", () => ({ computeConnectionMetrics: async () => metrics }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    weeklyDigest: { findFirst: async () => null },
    quickBooksConnection: { findUnique: async () => null },
    job: { findMany: async () => [] },
  },
}));
vi.mock("@/lib/weekOverWeek", () => ({
  computeWeekOverWeek: () => ({ changes: [] }),
  rebuildPending: () => false,
  renderWeekOverWeek: () => "What changed: nothing.",
  weekOverWeekForModel: () => ({}),
}));
vi.mock("@/lib/opportunityData", () => ({
  getOpportunityData: async () => {
    throw new Error("not needed here");
  },
}));
vi.mock("@/lib/briefHeadline", () => ({
  briefTileJobs: () => ({}),
  computeBriefHeadline: () => null,
  snapshotFromFeed: () => null,
}));

import {
  aiAttemptPlan,
  generateWeeklyDigest,
  generateWeeklyDigestForConnection,
  SUMMARY_UNAVAILABLE,
  SummaryOutOfTimeError,
  summaryToReuse,
  withSummaryForRetry,
} from "../digest";

beforeEach(() => {
  ai.calls.length = 0;
  ai.fail = null;
});

describe("how long a summary request gets", () => {
  it("gets its usual wait and a second try when there's time", () => {
    expect(aiAttemptPlan(Number.POSITIVE_INFINITY, 45_000)).toEqual({ timeoutMs: 45_000, retries: 1, limited: false });
    expect(aiAttemptPlan(100_000, 45_000)).toEqual({ timeoutMs: 45_000, retries: 1, limited: false });
  });

  it("says when the deadline cut it down, and when there's no time at all", () => {
    expect(aiAttemptPlan(60_000, 45_000)).toEqual({ timeoutMs: 45_000, retries: 0, limited: true });
    expect(aiAttemptPlan(30_000, 45_000)).toEqual({ timeoutMs: 30_000, retries: 0, limited: true });
    expect(aiAttemptPlan(10_000, 45_000)).toBeNull();
  });
});

describe("writing the summary against a deadline", () => {
  it("doesn't ask at all when there's no time, and says it was the time", async () => {
    const err = await generateWeeklyDigest(metrics as any, "Acme", {} as any, Date.now() + 5_000).catch((e) => e);
    expect(err).toBeInstanceOf(SummaryOutOfTimeError);
    expect(ai.calls).toHaveLength(0);
  });

  it("blames the time when a request cut short by the deadline fails", async () => {
    ai.fail = new Error("Request timed out.");
    const err = await generateWeeklyDigest(metrics as any, "Acme", {} as any, Date.now() + 60_000).catch((e) => e);
    expect(err).toBeInstanceOf(SummaryOutOfTimeError);
    expect(ai.calls).toEqual([{ timeoutMs: 45_000, retries: 0 }]);
  });

  it("blames the AI when a request with its full time fails", async () => {
    ai.fail = new Error("overloaded");
    const err = await generateWeeklyDigest(metrics as any, "Acme", {} as any, Date.now() + 200_000).catch((e) => e);
    expect(err).not.toBeInstanceOf(SummaryOutOfTimeError);
    expect(err.message).toBe("overloaded");
  });
});

describe("what the model is told about estimates", () => {
  it("marks estimates set from the target margin, and only those", async () => {
    ai.fail = null;
    const job = (jobId: string) => ({
      jobId, jobName: jobId, status: "completed", estimatedCost: 23_800, actualCost: 30_400,
      varianceVsEstimate: 6_600, varianceVsEstimatePct: 0.277,
    });
    const withJobs = { ...metrics, briefJobIds: ["filled", "priced"], jobs: [job("filled"), job("priced")], topConcerns: [job("filled")] };
    await generateWeeklyDigest(withJobs as any, "Acme", {} as any, Date.now() + 200_000, new Set(["filled"]));
    const text: string = ai.lastParams.messages[0].content;
    const data = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
    expect(data.jobs.find((j: any) => j.jobId === "filled").estimateSetFromTargetMargin).toBe(true);
    expect(data.jobs.find((j: any) => j.jobId === "priced").estimateSetFromTargetMargin).toBeUndefined();
    expect(data.topConcerns[0].estimateSetFromTargetMargin).toBe(true);
    expect(ai.lastParams.system).toMatch(/estimateSetFromTargetMargin/);
  });
});

describe("the weekly send", () => {
  const send = { allowMissingSummary: true, deferWhenOutOfTime: true };

  it("defers a company started too late, instead of sending without the summary", async () => {
    const err = await generateWeeklyDigestForConnection("c1", metrics.weekStarting, "Acme", { ...send, deadline: Date.now() + 5_000 }).catch(
      (e) => e
    );
    expect(err).toBeInstanceOf(SummaryOutOfTimeError);
  });

  it("sends without the summary when deferring would miss the week", async () => {
    const r = await generateWeeklyDigestForConnection("c1", metrics.weekStarting, "Acme", {
      allowMissingSummary: true,
      deferWhenOutOfTime: false,
      deadline: Date.now() + 5_000,
    });
    expect(r.summaryMissing).toBe(true);
    expect(r.body).toBe(SUMMARY_UNAVAILABLE);
  });

  it("still sends without the summary on a real AI failure", async () => {
    ai.fail = new Error("overloaded");
    const r = await generateWeeklyDigestForConnection("c1", metrics.weekStarting, "Acme", { ...send, deadline: Date.now() + 200_000 });
    expect(r.summaryMissing).toBe(true);
  });

  it("reuses the summary an earlier try wrote, without asking again", async () => {
    const r = await generateWeeklyDigestForConnection("c1", metrics.weekStarting, "Acme", {
      ...send,
      deadline: Date.now() + 5_000,
      storedSummary: "Last hour's summary.",
    });
    expect(r.body).toBe("Last hour's summary.");
    expect(r.summaryMissing).toBe(false);
    expect(r.narrative).toContain("Last hour's summary.");
    expect(ai.calls).toHaveLength(0);
  });
});

describe("the summary kept for a retry", () => {
  it("is stored with the metrics only when one was written", () => {
    const stored = withSummaryForRetry({ jobs: [] }, { kind: "narrative", body: "The summary.", summaryMissing: false });
    expect(summaryToReuse(stored)).toBe("The summary.");
    expect(summaryToReuse(withSummaryForRetry({ jobs: [] }, { kind: "narrative", body: SUMMARY_UNAVAILABLE, summaryMissing: true }))).toBeNull();
    expect(summaryToReuse(withSummaryForRetry({ jobs: [] }, { kind: "data_health", body: "Notice.", summaryMissing: false }))).toBeNull();
  });

  it("isn't found in metrics that don't carry one", () => {
    expect(summaryToReuse(null)).toBeNull();
    expect(summaryToReuse({ jobs: [] })).toBeNull();
    expect(summaryToReuse({ briefSendSummary: "  " })).toBeNull();
    expect(summaryToReuse("text")).toBeNull();
  });
});

describe("the weekly-email route", () => {
  const route = readFileSync(path.join(__dirname, "../../app/api/cron/weekly-email/route.ts"), "utf8");

  it("gives the attempt back and defers when the summary ran out of time", () => {
    expect(route).toMatch(/instanceof SummaryOutOfTimeError\)\) throw err;[\s\S]{0,400}await release\(refund\);[\s\S]{0,80}status: "deferred"/);
    expect(route).toMatch(/deferWhenOutOfTime: withinCatchUp\(/);
  });

  it("stores the summary it wrote and reuses it on a retry", () => {
    expect(route).toContain("summaryToReuse(existing?.metrics)");
    expect(route).toContain("storedSummary,");
    expect(route).toContain("withSummaryForRetry(metrics, { kind, body, summaryMissing })");
    expect(route).toMatch(/metrics: toStore as any/);
  });
});
