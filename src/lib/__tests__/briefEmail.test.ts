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
      tiles: { overEstimate: [], unbilled: [{ jobId: "j1", jobName: "Harborview <Roof>", amount: 31000 }] },
      recipient: "pm@example.com",
      ownerEmail: "owner@example.com",
    });
    expect(email.subject).toBe("Acme & Sons: Weekly Profit Brief, week of Sep 21, 2026");
    expect(email.html).toContain("Acme &amp; Sons");
    expect(email.html).toContain("Work done, not yet billed");
    // The money comes with the job it's on.
    expect(email.html).toContain("Not yet billed: <a");
    expect(email.text).toContain("Not yet billed: Harborview <Roof> ($31,000).");
    expect(email.html).toContain(`/api/company/open?company=conn1&amp;next=${encodeURIComponent("/dashboard")}"`);
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
    expect(email.html).toContain(`next=${encodeURIComponent("/dashboard/jobs/j1")}`);
    expect(email.text).toContain("$10,200");
  });
});

describe("links in the brief and alert emails open the email's own company", () => {
  const m = metrics([job("j1", "Harborview Roof", { varianceVsEstimatePct: 0.2, varianceVsEstimate: 14000 })]);
  const hrefs = (html: string) => Array.from(html.matchAll(/href="([^"]+)"/g), (x) => x[1].replace(/&amp;/g, "&"));
  const open = "https://jobprofitai.com/api/company/open?company=conn1&next=";

  it("sends every dashboard and Settings link through the company switch", () => {
    const brief = renderBriefEmail({
      connectionId: "conn1",
      companyName: "Acme",
      weekStarting: m.weekStarting,
      kind: "narrative",
      body: "Summary.",
      weekOverWeek: computeWeekOverWeek(null, m),
      metrics: m,
      tiles: { overEstimate: [{ jobId: "j1", jobName: "Harborview Roof", pct: 0.2 }], unbilled: [] },
      recipient: "owner@example.com",
      ownerEmail: "owner@example.com",
    });
    const alert = renderAlertEmail({
      connectionId: "conn1",
      companyName: "Acme",
      alerts: [{ jobId: "j1", jobName: "Harborview Roof", kind: "over_budget", issue: "Over", financialImpact: 1 }],
      recipient: "owner@example.com",
      ownerEmail: "owner@example.com",
    });
    for (const html of [brief.html, alert.html]) {
      // Every link into the app, other than the unsubscribe links.
      const toApp = hrefs(html).filter((h) => h.startsWith("https://jobprofitai.com") && !h.includes("/api/brief/unsubscribe"));
      expect(toApp.length).toBeGreaterThan(2);
      for (const h of toApp) expect(h.startsWith(open)).toBe(true);
    }
    expect(hrefs(brief.html)).toContain(`${open}${encodeURIComponent("/dashboard/settings")}`);
    expect(brief.text).toContain(`Change the day and time: ${open}${encodeURIComponent("/dashboard/settings")}`);
    expect(alert.text).not.toContain("https://jobprofitai.com/dashboard");
  });

  it("offers stopping the emails for every company only when the account has more than one", () => {
    const input = {
      connectionId: "conn1",
      companyName: "Acme",
      weekStarting: m.weekStarting,
      kind: "narrative" as const,
      body: "Summary.",
      weekOverWeek: computeWeekOverWeek(null, m),
      metrics: m,
      recipient: "pm@example.com",
      ownerEmail: "owner@example.com",
    };
    expect(renderBriefEmail(input).html).not.toContain("every company on this account");
    const many = renderBriefEmail({ ...input, hasOtherCompanies: true });
    expect(many.html).toContain("Stop it for every company on this account");
    const all = hrefs(many.html).find((h) => h.includes("all=1"))!;
    const url = new URL(all);
    // Same signature as the one-company link: it can only remove this address.
    expect(verifyUnsubscribe(url.searchParams.get("c")!, url.searchParams.get("e")!, url.searchParams.get("t")!)).toBe("pm@example.com");
  });
});

describe("the brief's tiles", () => {
  const input = (m: ConnectionMetrics, extra: Record<string, unknown> = {}) => ({
    connectionId: "conn1",
    companyName: "Acme",
    weekStarting: m.weekStarting,
    kind: "narrative" as const,
    body: "Summary.",
    weekOverWeek: computeWeekOverWeek(null, m),
    metrics: m,
    recipient: "a@example.com",
    ownerEmail: "a@example.com",
    ...extra,
  });

  it("never shows unbilled money without the jobs it's on", () => {
    // Unbilled on the brief's own figures, but the feed (which leaves out
    // jobs past their estimate and small amounts) wasn't available.
    const m = metrics([job("j1", "Harborview", { overUnderBilling: -48000 })]);
    const email = renderBriefEmail(input(m));
    expect(email.html).not.toContain("Work done, not yet billed");
    const withFeed = renderBriefEmail(input(m, { tiles: { overEstimate: [], unbilled: [] } }));
    expect(withFeed.html).not.toContain("Work done, not yet billed");
  });

  it("names the jobs over their estimate, and says when there are more", () => {
    const over = Array.from({ length: 7 }, (_, i) => ({ jobId: `j${i}`, jobName: `Job ${i}`, pct: 0.3 - i * 0.01 }));
    const m = metrics([]);
    const email = renderBriefEmail(input(m, { tiles: { overEstimate: over, unbilled: null } }));
    expect(email.text).toContain("Jobs 10%+ over estimate: 7");
    expect(email.text).toContain("10%+ over estimate: Job 0 (30% over), Job 1 (29% over), Job 2 (28% over), Job 3 (27% over), Job 4 (26% over), and 2 more.");
  });

  it("points to the 'Is each job a Class?' question while it's unanswered", () => {
    const m = metrics([]);
    expect(renderBriefEmail(input(m)).text).not.toContain("Is each job a Class in your QuickBooks?");
    const pending = renderBriefEmail(input(m, { jobSourceQuestionPending: true }));
    expect(pending.text).toContain("Is each job a Class in your QuickBooks?");
    expect(pending.html).toContain("Is each job a Class in your QuickBooks?");
  });

  it("doesn't call a brief without its written summary an AI summary", () => {
    const m = metrics([]);
    expect(renderBriefEmail(input(m)).html).toContain("The summary is written by AI");
    const without = renderBriefEmail(input(m, { summaryMissing: true, body: "The written summary couldn't be produced this week." }));
    expect(without.html).not.toContain("written by AI");
    expect(without.html).toContain("calculated from your QuickBooks data");
  });
});
