import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import OpportunitySummary from "@/components/opportunities/OpportunitySummary";

// Two things a staging walkthrough as a client login turned up (Nov 18):
//  1. The "Set your target margin" box offered a client's view-only login a
//     link to Settings, where it can't set anything (the settings routes
//     refuse it). It now says who can set it, with no link.
//  2. Revenue minus Tracked Job Costs didn't equal Job Gross Profit, with
//     nothing on screen saying why: gross profit only counts jobs with both
//     revenue and costs. The tiles now say so.

const SRC = join(__dirname, "..", "..");
const read = (rel: string) => readFileSync(join(SRC, rel), "utf8");
const flat = (rel: string) => read(rel).replace(/\s+/g, " ");
const noTarget = { targetSet: false } as never;

describe("the target margin box for a client's view-only login", () => {
  it("still offers the owner and team the link to set it", () => {
    const html = renderToStaticMarkup(createElement(OpportunitySummary, { summary: noTarget }));
    expect(html).toContain("Set your target margin to see what your pricing is costing you.");
    expect(html).toContain('href="/dashboard/settings"');
  });

  it("gives a client no link, and says the bookkeeper sets it", () => {
    const html = renderToStaticMarkup(createElement(OpportunitySummary, { summary: noTarget, viewOnly: true }));
    expect(html).not.toContain("href=");
    expect(html).not.toContain("Set your target margin");
    expect(html).toContain("No target margin is set for this company yet.");
    expect(html).toContain("bookkeeper");
  });

  it("is told it's a client on both pages that show the box", () => {
    expect(flat("app/dashboard/page.tsx")).toContain(
      "<OpportunitySummary summary={opportunities.feed.summary} viewOnly={viewOnly} />"
    );
    expect(flat("app/dashboard/opportunities/page.tsx")).toContain(
      "<OpportunitySummary summary={feed.summary} viewOnly={viewOnly} />"
    );
  });
});

describe("the dashboard's profit tiles say which jobs they cover", () => {
  it("notes that Job Gross Profit and the margin only count jobs with both revenue and costs", () => {
    const page = flat("app/dashboard/page.tsx");
    expect(page).toContain(
      'label="Job Gross Profit" value={formatCurrency(profitData.totals.jobGrossProfit)} note="Only jobs with both revenue and costs"'
    );
    expect(page).toContain(
      'label={statusFilter === "open" ? "Margin to Date" : "Job Margin"} value={formatPct(profitData.totals.avgJobMarginPct)} note="On those same jobs"'
    );
    expect(page).toContain('{note ? <p className="mt-1 text-[11px] text-gray-400">{note}</p> : null}');
  });

  it("uses no em or en dashes in the changed files", () => {
    const DASHES = new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`);
    for (const f of [
      "components/opportunities/OpportunitySummary.tsx",
      "app/dashboard/page.tsx",
      "app/dashboard/opportunities/page.tsx",
      "lib/__tests__/dashboardClarity.test.ts",
    ]) {
      expect({ f, dash: DASHES.test(read(f)) }).toEqual({ f, dash: false });
    }
  });
});
