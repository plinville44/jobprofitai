import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));

import { renderAlertEmail, renderBriefEmail, unsubscribeUrl, verifyUnsubscribe } from "../email/briefEmail";
import { computeWeekOverWeek } from "../weekOverWeek";
import type { ConnectionMetrics, JobMetrics } from "../profitability";

function job(id: string, name: string, overrides: Partial<JobMetrics> = {}): JobMetrics {
  return {
    jobId: id,
    jobName: name,
    customerName: null,
    status: "open",
    estimatedCost: 70000,
    actualCost: 50000,
    estimatedRevenue: 100000,
    actualRevenue: 40000,
    costByCategory: {},
    marginPct: 0.2,
    varianceVsEstimate: null,
    varianceVsEstimatePct: null,
    overUnderBilling: -31000,
    percentComplete: 0.71,
    flags: [],
    ...overrides,
  };
}

function metrics(jobs: JobMetrics[]): ConnectionMetrics {
  return {
    connectionId: "conn1",
    weekStarting: new Date("2026-09-21T00:00:00Z"),
    jobs,
    briefJobIds: jobs.map((j) => j.jobId),
    topConcerns: [],
    totals: { activeJobs: jobs.length, totalActualCost: 50000, totalActualRevenue: 40000, blendedMarginPct: 0.2 },
    dataHealth: {} as ConnectionMetrics["dataHealth"],
    briefDataHealth: {} as ConnectionMetrics["dataHealth"],
  };
}

describe("weekly brief email", () => {
  const m = metrics([job("j1", "Harborview <Roof>")]);
  const wow = computeWeekOverWeek(null, m);

  it("renders headline figures, the summary and a dashboard link, with job names escaped", () => {
    const email = renderBriefEmail({
      connectionId: "conn1",
      companyName: "Acme & Sons",
      weekStarting: m.weekStarting,
      kind: "narrative",
      body: "Harborview is the one to watch.\n\nEverything else is on track.",
      weekOverWeek: wow,
      metrics: m,
      recipient: "pm@example.com",
      ownerEmail: "owner@example.com",
    });
    expect(email.subject).toBe("Acme & Sons: Weekly Profit Brief, week of Sep 21, 2026");
    expect(email.html).toContain("Acme &amp; Sons");
    expect(email.html).toContain("Work done, not yet billed");
    expect(email.html).toContain("/dashboard");
    expect(email.html).not.toContain("<Roof>");
    expect(email.text).toContain("Everything else is on track.");
    expect(email.html).toContain("owner@example.com added you");
    expect(email.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
  });

  it("gives each recipient an unsubscribe link that only works for them", () => {
    const url = new URL(unsubscribeUrl("conn1", "PM@example.com"));
    const c = url.searchParams.get("c")!;
    const e = url.searchParams.get("e")!;
    const t = url.searchParams.get("t")!;
    expect(verifyUnsubscribe(c, e, t)).toBe("pm@example.com");
    expect(verifyUnsubscribe("conn2", e, t)).toBeNull();
    const other = Buffer.from("someone@else.com").toString("base64url");
    expect(verifyUnsubscribe(c, other, t)).toBeNull();
  });
});

describe("profit alert email", () => {
  it("names each job and links to it", () => {
    const email = renderAlertEmail({
      connectionId: "conn1",
      companyName: "Acme",
      alerts: [{ jobId: "j1", jobName: "Harborview", kind: "over_budget", issue: "Actual costs are 14% over the estimate", financialImpact: 10200 }],
      recipient: "owner@example.com",
      ownerEmail: "owner@example.com",
    });
    expect(email.subject).toBe("Acme: Harborview needs a look");
    expect(email.html).toContain("/dashboard/jobs/j1");
    expect(email.text).toContain("$10,200");
  });
});
