import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));

import { computeBriefHeadline, type BriefOpportunitySnapshot } from "../briefHeadline";
import { renderBriefEmail } from "../email/briefEmail";
import { computeWeekOverWeek } from "../weekOverWeek";
import type { ConnectionMetrics } from "../profitability";

const snap = (o: Partial<BriefOpportunitySnapshot> = {}): BriefOpportunitySnapshot => ({
  targetSet: true,
  pricingGap: 0,
  openJobRisk: 0,
  openJobsAtRisk: 0,
  estimatesShortfall: 0,
  estimatesFlagged: 0,
  unbilledWork: 0,
  openRiskByJob: {},
  top: [],
  ...o,
});

describe("weekly brief headline", () => {
  it("leads with risk that's new or has grown since the last brief", () => {
    const now = snap({ openJobRisk: 9_000, openJobsAtRisk: 2, openRiskByJob: { a: 6_000, b: 3_000 } });
    const prior = { opportunities: { openRiskByJob: { a: 4_000, b: 3_500 } } };
    const h = computeBriefHeadline(now, prior, "Acme");
    // a grew by 2,000; b shrank, which doesn't offset it.
    expect(h.newRisk).toBe(2_000);
    expect(h.subject).toBe("Acme: $2,000 of new margin risk this week");
    expect(h.headline).toContain("$2,000 of new margin risk");
  });

  it("has nothing to call new on the first brief, and falls back to what's there", () => {
    const h = computeBriefHeadline(snap({ estimatesFlagged: 2, estimatesShortfall: 3_100 }), null, "Acme");
    expect(h.newRisk).toBeNull();
    expect(h.subject).toBe("Acme: 2 estimates priced below your target");
    expect(computeBriefHeadline(snap({ pricingGap: 40_000 }), {}, "Acme").headline).toContain("would have added $40,000");
    expect(computeBriefHeadline(snap(), {}, "Acme").subject).toBeNull();
  });

  it("states small amounts rather than calling them nothing, and asks for a target when there isn't one", () => {
    expect(computeBriefHeadline(snap({ openJobRisk: 200, openJobsAtRisk: 1, pricingGap: 300 }), null, "Acme").headline).toBe("$200 is at risk on 1 open job.");
    expect(computeBriefHeadline(snap({ pricingGap: 300 }), null, "Acme").headline).toContain("would have added $300");
    const small = computeBriefHeadline(snap({ openJobRisk: 450, openJobsAtRisk: 1, openRiskByJob: { j: 450 } }), { opportunities: { openRiskByJob: {} } }, "Acme");
    expect(small.headline).toBe("$450 of new margin risk on your open jobs since the last brief.");
    expect(small.subject).toBeNull();
    expect(computeBriefHeadline(snap({ targetSet: false }), null, "Acme").headline).toContain("Set a target margin");
  });

  it("only gives an all clear for what was actually checked", () => {
    const nothing = computeBriefHeadline(snap({ jobsJudged: 0, openJobsChecked: 0 }), null, "Acme").headline;
    expect(nothing).toContain("There wasn't enough in QuickBooks to check");
    const some = computeBriefHeadline(snap({ jobsJudged: 5, openJobsChecked: 0 }), null, "Acme").headline;
    expect(some).toBe("Your 5 jobs finished in the last 12 months average at or above your target, and no open job has a cost estimate or a firm forecast to check yet.");
    const both = computeBriefHeadline(snap({ jobsJudged: 1, openJobsChecked: 3 }), null, "Acme").headline;
    expect(both).toBe("Your 1 job finished in the last 12 months is at or above your target, and none of the 3 open jobs we could check is heading below target.");
    // Snapshots stored before the counts existed don't claim anything specific.
    expect(computeBriefHeadline(snap(), null, "Acme").headline).toBe("Nothing on your open jobs or your recent pricing needs attention this week.");
  });

  it("puts the headline and top opportunities at the top of the email", () => {
    const m: ConnectionMetrics = {
      connectionId: "c1",
      weekStarting: new Date("2026-09-21T00:00:00Z"),
      jobs: [],
      briefJobIds: [],
      topConcerns: [],
      totals: { activeJobs: 0, totalActualCost: 0, totalActualRevenue: 0, blendedMarginPct: null },
      dataHealth: {} as ConnectionMetrics["dataHealth"],
      briefDataHealth: {} as ConnectionMetrics["dataHealth"],
    } as ConnectionMetrics;
    const headline = computeBriefHeadline(
      snap({
        openJobRisk: 5_000,
        openJobsAtRisk: 1,
        openRiskByJob: { j: 5_000 },
        top: [{ title: "Remodel <jobs> are priced low", impact: 12_000, impactLabel: "more profit a year", impactKind: "profit", href: "/dashboard/opportunities#job_type_pricing%3Aremodel" }],
      }),
      { opportunities: { openRiskByJob: {} } },
      "Acme"
    );
    const email = renderBriefEmail({
      connectionId: "c1",
      companyName: "Acme",
      weekStarting: m.weekStarting,
      kind: "narrative",
      body: "Summary.",
      weekOverWeek: computeWeekOverWeek(null, m),
      metrics: m,
      headline,
      recipient: "a@example.com",
      ownerEmail: "a@example.com",
    });
    expect(email.subject).toBe("Acme: $5,000 of new margin risk this week");
    expect(email.html).toContain("Remodel &lt;jobs&gt; are priced low");
    expect(email.html.indexOf("new margin risk")).toBeLessThan(email.html.indexOf("What changed"));
    expect(email.text).toContain("What to change, and what it's worth:");
  });
});
