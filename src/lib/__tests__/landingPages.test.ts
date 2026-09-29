import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { LANDING_PAGES, LANDING_SLUGS } from "@/lib/landingPages";

// The ad landing pages (src/app/lp). Each Google Ads ad group sends people to
// one of these, so each must exist, stay out of search, and hold to the same
// copy rules as the rest of the site.

const SRC = join(__dirname, "..", "..");
const read = (rel: string) => readFileSync(join(SRC, rel), "utf8");
const allCopy = () => JSON.stringify(LANDING_PAGES) + read("components/marketing/LandingPage.tsx") + read("app/lp/layout.tsx");

describe("ad landing pages", () => {
  it("has the four ad groups' pages, each wired to its own copy", () => {
    expect([...LANDING_SLUGS].sort()).toEqual(["estimates", "job-profit", "pricing", "wip"]);
    for (const slug of LANDING_SLUGS) {
      const file = `app/lp/${slug}/page.tsx`;
      expect({ file, exists: existsSync(join(SRC, file)) }).toEqual({ file, exists: true });
      const page = read(file);
      expect(page).toContain(`landingMetadata("${slug}")`);
      expect(page).toContain(`<LandingPage slug="${slug}" />`);
      expect(LANDING_PAGES[slug].slug).toBe(slug);
    }
  });

  it("keeps every page out of search and out of the sitemap", () => {
    expect(read("components/marketing/LandingPage.tsx")).toContain("robots: { index: false, follow: true }");
    expect(read("app/sitemap.ts")).not.toContain("/lp");
    expect(read("app/robots.ts")).not.toContain("/lp");
  });

  it("doesn't repeat the hero preview further down the page", () => {
    for (const p of Object.values(LANDING_PAGES)) {
      expect({ slug: p.slug, repeated: p.sections.includes(p.heroPreview) }).toEqual({ slug: p.slug, repeated: false });
      expect(new Set(p.sections).size).toBe(p.sections.length);
    }
  });

  it("keeps titles and descriptions to a length search results show", () => {
    for (const p of Object.values(LANDING_PAGES)) {
      // The site template adds " | JobProfitAI".
      expect({ slug: p.slug, title: p.metaTitle.length <= 50 }).toEqual({ slug: p.slug, title: true });
      expect({ slug: p.slug, description: p.metaDescription.length <= 170 }).toEqual({ slug: p.slug, description: true });
    }
  });

  it("follows the house style: no en or em dashes", () => {
    expect(allCopy()).not.toMatch(/[–—]/);
  });

  it("calls the QuickBooks labor rate a cost rate, never a pay rate or wages", () => {
    expect(allCopy()).not.toMatch(/pay rate|wages only/i);
    expect(read("components/marketing/LandingPage.tsx")).toContain("cost rate on each QuickBooks time entry");
  });

  it("describes alerts the way the nightly alert works", () => {
    const text = read("components/marketing/LandingPage.tsx").replace(/\s+/g, " ");
    expect(text).toContain("after the nightly sync when an open job goes more than 10% over its estimate");
    expect(text).not.toMatch(/as soon as an open job goes over|the day a job goes over/);
  });

  it("offers one action: the header and every big button start the trial", () => {
    const layout = read("app/lp/layout.tsx");
    expect(layout).toContain('href="/signup"');
    // No site navigation on an ad page.
    expect(layout).not.toContain("SiteHeader");
    expect(layout).not.toContain("LogoLink");
  });
});
