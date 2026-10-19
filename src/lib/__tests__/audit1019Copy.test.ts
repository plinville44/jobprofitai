import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { LANDING_PAGES, LANDING_SLUGS } from "@/lib/landingPages";
import { TRADEMARK_NOTICE } from "@/components/marketing/trademark";
import { getSampleCompany, SAMPLE_JOBS, SAMPLE_NOW, SAMPLE_TARGET_PCT } from "@/lib/sampleCompany";
import { IDLE_JOB_DAYS } from "@/lib/profitability";
import { DISCONNECTED_RETENTION_DAYS, LAPSED_DISCONNECT_DAYS } from "@/lib/dataRetention";
import { NOT_SCHEDULED_NEED_TEXT } from "@/lib/wipSchedule";
import { jobChangeSentence } from "@/lib/weekOverWeek";
import { formatCurrency, formatPct } from "@/lib/format";
import { PLANS } from "@/lib/plans";

// Website and ad copy fixed before paid Google Ads went live (audit of
// 2026-10-19). Each block holds one finding to what the code does, so the
// claim can't drift back.

const SRC = join(__dirname, "..", "..");
const read = (rel: string) => readFileSync(join(SRC, rel), "utf8");
/** Source with line breaks and indentation collapsed, so wrapped JSX text can be matched. */
const flat = (rel: string) => read(rel).replace(/\s+/g, " ");

const HOME = "app/(marketing)/page.tsx";
const PRICING = "app/(marketing)/pricing/page.tsx";
const HOW = "app/(marketing)/how-it-works/page.tsx";
const DEMO = "app/(marketing)/demo/page.tsx";
const LANDING = "components/marketing/LandingPage.tsx";
const PREVIEW = "components/marketing/ProductPreview.tsx";
const COMPARISON = "components/marketing/QuickBooksComparison.tsx";
const FOOTER = "components/marketing/SiteFooter.tsx";
const LP_LAYOUT = "app/lp/layout.tsx";

describe("1. trademark notice", () => {
  it("is the wording Intuit gave us, word for word", () => {
    expect(TRADEMARK_NOTICE).toBe(
      "Intuit and QuickBooks are registered trademarks of Intuit Inc. Used with permission. JobProfitAI is an independent product and is not endorsed or sponsored by Intuit Inc."
    );
  });

  it("is what both footers show, and the old notice is gone", () => {
    for (const f of [FOOTER, LP_LAYOUT]) {
      const text = flat(f);
      expect({ f, renders: text.includes("{TRADEMARK_NOTICE}") }).toEqual({ f, renders: true });
      expect(text).toMatch(/import \{ TRADEMARK_NOTICE \} from "(\.\/|@\/components\/marketing\/)trademark"/);
      expect(text).not.toMatch(/registered in the United States|identification purposes|not affiliated with/);
    }
  });
});

describe("2. the WIP ad group says what comes from QuickBooks and what you add", () => {
  const wip = LANDING_PAGES.wip;

  it("has the new headline, title and description, with no 'automatically'", () => {
    expect(wip.headline).toBe("Your WIP report from QuickBooks, plus what to change and what it's worth");
    expect(wip.metaTitle).toBe("Your WIP report from your QuickBooks jobs");
    expect(wip.metaDescription).toBe(
      "The WIP schedule banks and bonding companies ask for, from your QuickBooks jobs and estimates, plus what to change on your pricing. 14 days free, no credit card."
    );
    expect(JSON.stringify(LANDING_PAGES)).not.toMatch(/automatically/i);
  });

  it("says cost budgets are added once, and the WIP schedule asks for one when it's missing", () => {
    const lp = flat(LANDING);
    expect(lp).toContain(
      "Contract values from your QuickBooks estimates. Add each open job's cost budget once, by hand or from a spreadsheet, and the rest updates on every sync"
    );
    expect(lp).not.toContain("Built from QuickBooks on every sync");
    // The schedule lists a job with no cost budget (or percent complete) as needing one.
    expect(NOT_SCHEDULED_NEED_TEXT.progress).toContain("needs a cost estimate");
    // The spreadsheet import exists.
    expect(read("components/dashboard/JobBudgetTools.tsx")).toContain('fetch("/api/jobs/import"');
  });

  it("lists on the homepage what you add once", () => {
    expect(flat(HOME)).toContain(
      "Revenue, costs and contract values come straight from your QuickBooks company. What QuickBooks can't tell us you add once: the type of each job (we suggest it for you to confirm), which jobs are finished, and a cost budget for open jobs."
    );
  });

  it("no longer says there's nothing to re-enter", () => {
    for (const f of [HOME, LANDING]) expect({ f, says: /nothing to re-enter/i.test(read(f)) }).toEqual({ f, says: false });
  });
});

describe("3. homepage setup step marks finished jobs", () => {
  it("asks for the target, the finished jobs and the job types", () => {
    const home = read(HOME);
    expect(home).toContain(
      "body={`Tell us the margin you aim for, mark the jobs that are finished (one click for jobs idle ${IDLE_JOB_DAYS} days), and confirm the job type we suggest for each.`}"
    );
    expect(home).toContain('import { IDLE_JOB_DAYS } from "@/lib/profitability"');
    expect(IDLE_JOB_DAYS).toBe(90);
    // The one click is the close-idle route, on the same constant.
    expect(read("app/api/jobs/close-idle/route.ts")).toContain("IDLE_JOB_DAYS * 86_400_000");
  });
});

describe("4. Pro-only checks are labelled Pro", () => {
  it("puts the cost-category outlier check under Pro on How It Works", () => {
    const how = flat(HOW);
    expect(how).toContain(
      "On Pro, in-progress jobs are also judged on where they&rsquo;re forecast to finish, and each job&rsquo;s cost categories are compared with similar completed jobs to catch outliers."
    );
    expect(how).not.toContain("and cost categories that look like outliers");
  });

  it("puts forecasts under Pro on the pricing page", () => {
    expect(flat(PRICING)).toContain("on Pro, forecasts where an in-progress job lands");
  });

  it("shows no Pro finding on the dashboard preview", () => {
    const { dashboard } = getSampleCompany();
    expect(dashboard.needsAttention.length).toBeGreaterThan(0);
    for (const i of dashboard.needsAttention) expect(["cost_outlier", "forecast_below_target"]).not.toContain(i.issueCode);
    expect(read(PREVIEW)).not.toMatch(/similar completed jobs|Riverside/);
    // Benchmarking is sold as Pro only.
    expect(PLANS.profit_intelligence_pro.marketingFeatures.join(" ")).toMatch(/Benchmarking/);
    expect(PLANS.profit_intelligence.marketingFeatures.join(" ")).not.toMatch(/Benchmarking/);
  });
});

describe("5. the kitchen example matches the sample company beside it", () => {
  const s = getSampleCompany();
  const kitchens = s.jobs.filter((j) => j.category === "c_kitchen" && j.status === "closed");
  const kitchenMargin = 1 - kitchens.reduce((a, j) => a + j.costs, 0) / kitchens.reduce((a, j) => a + j.revenue, 0);
  const labor = s.feed.items.find((i) => i.id === "job_type_pricing:c_kitchen")!.breakdown!.find((b) => b.category === "labor")!;

  it("rounds the kitchens' margin the way the copy does", () => {
    for (const f of [HOME, LANDING]) {
      const m = flat(f).match(/A report tells you kitchens came in at (\d+)%\./);
      expect({ f, found: m != null }).toEqual({ f, found: true });
      expect(Number(m![1])).toBe(Math.round(kitchenMargin * 100));
    }
    expect(formatPct(kitchenMargin)).toBe("20.9%");
  });

  it("says labor cost nearly everything customers paid for it, which it did", () => {
    expect(labor.marginPct).toBeGreaterThan(0);
    expect(labor.marginPct).toBeLessThan(0.05);
    for (const f of [HOME, LANDING, DEMO, HOW]) {
      const text = flat(f);
      expect({ f, says: text.includes("it cost nearly everything customers paid for it") }).toEqual({ f, says: true });
      expect({ f, oldIdiom: /nearly as much again/.test(text) }).toEqual({ f, oldIdiom: false });
    }
  });
});

describe("6. dashboard, job list and brief previews come from the engine", () => {
  const s = getSampleCompany();
  const names = new Set(SAMPLE_JOBS.map((j) => j.name));
  const job = (id: string) => s.jobs.find((j) => j.jobId === id)!;

  it("types no figures or job names by hand", () => {
    const preview = read(PREVIEW);
    for (const gone of ["Oakfield", "Riverside", "Laurel", "Elm Ct. Siding", "Spruce Ct.", "Mar 3", "no cost estimate on file", "EXAMPLE_", "InsightPreview"]) {
      expect({ gone, found: preview.includes(gone) }).toEqual({ gone, found: false });
    }
    // Hand-typed amounts were written like 10_200.
    expect(preview).not.toMatch(/\d_\d{3}/);
    expect(preview).toContain("const { dashboard } = getSampleCompany();");
    expect(preview).toContain("const { jobList, jobs } = getSampleCompany();");
    expect(preview).toContain("const { feed, brief, jobs, jobNames } = getSampleCompany();");
  });

  it("names only jobs the sample company has", () => {
    for (const i of s.dashboard.shown) expect({ name: i.jobName, known: names.has(i.jobName) }).toEqual({ name: i.jobName, known: true });
    for (const r of s.jobList) expect({ name: r.job.jobName, known: names.has(r.job.jobName) }).toEqual({ name: r.job.jobName, known: true });
    for (const c of s.brief.whatChanged.changes) expect({ name: c.jobName, known: names.has(c.jobName) }).toEqual({ name: c.jobName, known: true });
  });

  it("totals the dashboard the way the dashboard does", () => {
    const t = s.dashboard.totals;
    const belowTarget = new Set(s.dashboard.needsAttention.filter((i) => i.issueCode === "below_target_margin").map((i) => i.jobId));
    expect(t.jobsBelowTarget).toBe(belowTarget.size);
    expect(t.targetMarginPct).toBe(SAMPLE_TARGET_PCT);
    expect(s.dashboard.rangeLabel).toBe("Last 12 months");
    // Harborview is over its estimate at the engine's own severity.
    const harbor = s.dashboard.needsAttention.find((i) => i.jobId === "o1" && i.issueCode === "over_budget")!;
    expect(harbor.severity).toBe("medium");
    expect(harbor.financialImpact).toBe(job("o1").varianceVsEstimate);
    // No weekly snapshots in the sample, so no "margin declining" item.
    expect(s.dashboard.needsAttention.some((i) => i.issueCode === "margin_declining")).toBe(false);
    expect(s.dashboard.shown.length).toBe(4);
  });

  it("names the margin tile the way the dashboard does, with the engine's revenue-weighted value", () => {
    const label = '"open" ? "Margin to Date" : "Job Margin"';
    expect(flat("app/dashboard/page.tsx")).toContain(`statusFilter === ${label}`);
    const preview = flat(PREVIEW);
    expect(preview).toContain(`dashboard.statusLabel === ${label}, value: formatPct(t.avgJobMarginPct)`);
    expect(preview).not.toContain("Average Job Margin");
    // Every job with money in the period has both revenue and costs, so the
    // revenue-weighted margin is gross profit over revenue.
    const t = s.dashboard.totals;
    expect(t.avgJobMarginPct!).toBeCloseTo(t.jobGrossProfit! / t.revenue, 9);
  });

  it("dates the brief to the sample's own week and describes what really moved", () => {
    const w = s.brief.whatChanged;
    expect(s.brief.weekStarting.toISOString().slice(0, 10)).toBe("2026-08-31");
    expect(w.comparedToWeekStarting!.toISOString().slice(0, 10)).toBe("2026-08-24");
    expect(SAMPLE_NOW.getTime() - s.brief.weekStarting.getTime()).toBeLessThan(7 * 86_400_000);
    const lines = Object.fromEntries(w.changes.map((c) => [c.jobId, jobChangeSentence(c)]));
    expect(lines.o1).toBe(`$6,800 in new costs. Margin 24.0% to ${formatPct(job("o1").grossMarginPct)}. Now 14% over its estimate.`);
    expect(lines.k8).toBe(`Marked completed. Finished at ${formatPct(job("k8").grossMarginPct)} margin.`);
  });

  it("only says what's true in the brief's summary", () => {
    const preview = flat(PREVIEW);
    // Every open job has a cost estimate, so the old "no cost estimate" line would be false.
    for (const j of s.jobs.filter((x) => x.status === "open")) expect(j.estimatedCost).not.toBeNull();
    // The summary's figures are the over-budget job's own.
    const over = s.jobs.find((j) => j.status === "open" && j.flags.includes("over_budget_10pct_plus"))!;
    expect(over.jobId).toBe("o1");
    expect(formatCurrency(over.varianceVsEstimate)).toBe("$10,200");
    expect(over.grossMarginPct!).toBeGreaterThan(0);
    expect(preview).toContain("formatCurrency(over.varianceVsEstimate)");
    expect(preview).toContain('feed.items.find((i) => i.kind === "underbilled")');
  });

  it("uses no em or en dashes in what the previews show", () => {
    const text = JSON.stringify([s.dashboard.shown, s.jobList.map((r) => r.issue), s.brief.whatChanged.changes.map(jobChangeSentence)]);
    expect(/[\u2013\u2014]/.test(text)).toBe(false);
  });
});

describe("7. what happens to data after a trial or a move down", () => {
  const pricing = flat(PRICING);

  it("says when QuickBooks is disconnected and the data deleted, from the retention rules", () => {
    expect(pricing).toContain(
      "The profit intelligence features switch off, but nothing is deleted when the trial ends. Your account, your QuickBooks connection and every job analyzed stay where they are, and choosing a plan turns everything back on as you left it. After {LAPSED_DISCONNECT_DAYS} days without a plan we disconnect QuickBooks, and {DISCONNECTED_RETENTION_DAYS} days after that we delete the copied data."
    );
    expect(pricing).toContain('import { DISCONNECTED_RETENTION_DAYS, LAPSED_DISCONNECT_DAYS } from "@/lib/dataRetention"');
    expect([LAPSED_DISCONNECT_DAYS, DISCONNECTED_RETENTION_DAYS]).toEqual([90, 30]);
    expect(pricing).not.toContain("but nothing is deleted. Your account");
  });

  it("says companies past a smaller plan's limit are paused", () => {
    expect(pricing).toContain(
      "Companies past the new plan&rsquo;s limit stop syncing and get no briefs or alerts until you disconnect some or move back up."
    );
    // The nightly sync and the weekly brief both skip them.
    expect(read("app/api/cron/nightly-sync/route.ts")).toContain("overLimitConnectionIds");
    expect(read("app/api/cron/weekly-email/route.ts")).toContain("overLimitConnectionIds");
  });
});

describe("8. QuickBooks is described by what it does, not what it lacks", () => {
  const POSITIVE =
    "JobProfitAI works with the QuickBooks Online plan you already have and adds three things: what to change on your pricing, ranked by what it&rsquo;s worth; each pending estimate checked against your own past jobs; and whether a price change worked.";

  it("answers 'why not upgrade' and 'Plus already does this' positively", () => {
    for (const f of [LANDING, PRICING]) expect({ f, positive: flat(f).includes(POSITIVE) }).toEqual({ f, positive: true });
    expect(flat(LANDING)).not.toMatch(/A higher QuickBooks plan|doesn&rsquo;t rank/);
    expect(flat(PRICING)).not.toMatch(/It doesn&rsquo;t compare that margin|won&rsquo;t tell you|project tools that cover some/);
  });

  it("credits Advanced with its construction reports", () => {
    expect(flat(COMPARISON)).toContain("On Advanced, construction reports too: budget against actual, change orders, WIP, and flags when a project's costs run over");
  });

  it("never says QuickBooks lacks WIP, budgets, job costing or overrun alerts", () => {
    const lacks =
      /(QuickBooks|Plus|Advanced)[^.]{0,40}(doesn(&rsquo;|')t|does not|won(&rsquo;|')t|has no|lacks|no way to)[^.]{0,80}(WIP|work in progress|budget against actual|budget vs|job cost|overrun|alerts?\b)/i;
    for (const f of [HOME, PRICING, HOW, DEMO, LANDING, COMPARISON, "components/marketing/PlanGuide.tsx", "components/marketing/fitCheckRules.ts"]) {
      expect({ f, lacks: lacks.test(flat(f)) }).toEqual({ f, lacks: false });
    }
    expect(lacks.test(JSON.stringify(LANDING_PAGES))).toBe(false);
  });
});

describe("9. page metadata", () => {
  it("gives the homepage an absolute title, so the brand isn't doubled", () => {
    expect(flat(HOME)).toContain('title: { absolute: "JobProfitAI: Profit Intelligence for QuickBooks" }');
    expect(read("app/layout.tsx")).toContain('template: "%s | JobProfitAI"');
  });

  it("gives each landing page its own share card", () => {
    const lp = flat(LANDING);
    for (const piece of [
      "openGraph: {",
      "title: `${page.metaTitle} | JobProfitAI`",
      "description: page.metaDescription",
      "url: `/lp/${slug}`",
      "images: [OG_IMAGE]",
    ]) {
      expect({ piece, found: lp.includes(piece) }).toEqual({ piece, found: true });
    }
    expect(lp).toContain('import { OG_IMAGE } from "@/lib/siteMeta"');
    for (const slug of LANDING_SLUGS) expect(read(`app/lp/${slug}/page.tsx`)).toContain(`landingMetadata("${slug}")`);
  });
});

describe("10. team logins and labor burden on the landing pages", () => {
  const lp = flat(LANDING);

  it("gives each plan's team logins from the plan catalog", () => {
    expect(lp).toContain(
      "`Team logins for your office manager, project manager or bookkeeper: ${PLANS.profit_intelligence.limits.maxTeamMembers} on ${PLANS.profit_intelligence.name}, ${PLANS.profit_intelligence_pro.limits.maxTeamMembers} on Pro`"
    );
    expect(lp).not.toContain('"3 team logins');
    expect([PLANS.profit_intelligence.limits.maxTeamMembers, PLANS.profit_intelligence_pro.limits.maxTeamMembers]).toEqual([3, 10]);
  });

  it("says the burden is the one you set, not one JobProfitAI detects", () => {
    expect(lp).toContain("plus the labor burden you set in Settings when that rate doesn't already include it");
    expect(lp).not.toContain("plus a labor burden only if");
    expect(flat(HOME)).toContain("plus the labor burden you set in Settings when those rates don&rsquo;t already include it");
  });
});

describe("11. who it's for", () => {
  it("says it works on Plus or Advanced with no upgrade, where the pages introduce the comparison", () => {
    for (const f of [HOME, LANDING]) {
      expect({ f, says: flat(f).includes("Works with QuickBooks Online Plus or Advanced, with no upgrade and nothing new to switch to.") }).toEqual({
        f,
        says: true,
      });
    }
  });
});
