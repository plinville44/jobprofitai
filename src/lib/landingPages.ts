/**
 * The ad landing pages under /lp. One entry per Google Ads ad group, so the
 * page a visitor lands on repeats the words they searched and the ad
 * promised (message match). Plain data: src/components/marketing/LandingPage.tsx
 * turns an entry into the page, and a test holds the copy to the house
 * style. Every page is noindex, so none of them competes with the homepage
 * in search.
 *
 * The marketing playbook's "Headlines and message match" table is the source
 * for these headlines. When a headline test finishes, change it here.
 */

export type LandingSlug = "pricing" | "estimates" | "job-profit" | "wip";

/** A product section a page can show, each with its preview from the sample company. */
export type LandingSection = "feed" | "breakdown" | "estimate" | "tracked" | "wip";

export interface LandingPageConfig {
  slug: LandingSlug;
  /** Browser tab and search snippet title (the site adds "| JobProfitAI"). */
  metaTitle: string;
  metaDescription: string;
  eyebrow: string;
  headline: string;
  subhead: string;
  /** The preview under the hero buttons. */
  heroPreview: LandingSection;
  /** The product sections, in order, after the QuickBooks comparison. */
  sections: LandingSection[];
}

export const LANDING_PAGES: Record<LandingSlug, LandingPageConfig> = {
  pricing: {
    slug: "pricing",
    metaTitle: "Find the jobs you're underpricing",
    metaDescription:
      "JobProfitAI works with QuickBooks and ranks what to change on your pricing by what it's worth in dollars, from your own finished jobs. 14 days free, no credit card.",
    eyebrow: "Pricing, from your own jobs",
    headline: "Find the jobs you're underpricing, and what it's costing you",
    subhead:
      "Works with QuickBooks. JobProfitAI compares your finished jobs and ranks what to change on your pricing by what it's worth in dollars.",
    heroPreview: "feed",
    sections: ["breakdown", "estimate", "tracked"],
  },
  estimates: {
    slug: "estimates",
    metaTitle: "Check every estimate before you send it",
    metaDescription:
      "Each pending QuickBooks estimate, checked against what your own finished jobs of the same type really cost, before the customer sees it. 14 days free, no credit card.",
    eyebrow: "Estimate Check",
    headline: "Check every estimate against your own past jobs, before you send it",
    subhead:
      "Each pending QuickBooks estimate, costed from its hours and items where the lines list them, and checked against what your finished jobs of the same type really cost.",
    heroPreview: "estimate",
    sections: ["feed", "breakdown", "tracked"],
  },
  "job-profit": {
    slug: "job-profit",
    metaTitle: "QuickBooks job profit, plus what to change",
    metaDescription:
      "Profit on every job from QuickBooks, with labor at your QuickBooks cost rates, then a ranked list of what to change and what it's worth. 14 days free, no credit card.",
    eyebrow: "Job profit for QuickBooks",
    headline: "QuickBooks job profit, plus what to change and what it's worth",
    subhead:
      "Profit on every job with labor at your QuickBooks cost rates, then a ranked list of what to change on your pricing and the money you're owed.",
    heroPreview: "feed",
    sections: ["estimate", "breakdown", "tracked"],
  },
  wip: {
    slug: "wip",
    metaTitle: "Your WIP report, built from QuickBooks",
    metaDescription:
      "The work in progress schedule banks and bonding companies ask for, built from QuickBooks automatically, plus what to change on your pricing. 14 days free, no credit card.",
    eyebrow: "WIP report for QuickBooks",
    headline: "Your WIP report, built from QuickBooks automatically. Then what to change.",
    subhead:
      "The bank-ready WIP schedule, plus what a WIP report can't tell you: what to change on your pricing, ranked in dollars.",
    heroPreview: "wip",
    sections: ["feed", "estimate", "tracked"],
  },
};

export const LANDING_SLUGS = Object.keys(LANDING_PAGES) as LandingSlug[];
