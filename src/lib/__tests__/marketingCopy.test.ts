import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { QUESTIONS, notesFor, planFor, type Answers } from "@/components/marketing/fitCheckRules";
import { PLANS, PARTNER_TIERS } from "@/lib/plans";
import { OG_IMAGE } from "@/lib/siteMeta";

// The website, legal pages and in-app settings text make promises about what
// the product does. These tests hold the ones that have gone wrong before to
// what the code does (audit of 2026-09-28, section 5).

const SRC = join(__dirname, "..", "..");
const ROOT = join(SRC, "..");
const read = (rel: string) => readFileSync(join(SRC, rel), "utf8");
/** Source with line breaks and indentation collapsed, so wrapped JSX text can be matched. */
const flat = (rel: string) => read(rel).replace(/\s+/g, " ");

const ALL_ANSWERS: Answers = { qb: "online", jobs: "projects", costs: "always", labor: "time", open: "under25", companies: "1" };

describe("fit check", () => {
  it("sends a bookkeeper with 2 or 3 clients to Pro, and 4 or more to Firm", () => {
    const two = planFor({ ...ALL_ANSWERS, companies: "2to3" });
    expect(two?.name).toBe(PLANS.profit_intelligence_pro.name);
    expect(two?.why).toMatch(/portfolio page/);
    const four = planFor({ ...ALL_ANSWERS, companies: "4plus" });
    expect(four?.name).toBe(PLANS.firm.name);
    // Being a bookkeeper is no longer an answer that skips straight to Firm.
    const companies = QUESTIONS.find((q) => q.id === "companies")!;
    expect(companies.options.map((o) => o.label)).toEqual(["One", "2 or 3", "4 or more"]);
  });

  it("says plainly what happens past 100 open jobs on the $149 plan", () => {
    const pick = planFor({ ...ALL_ANSWERS, open: "25to100" });
    expect(pick?.name).toBe(PLANS.profit_intelligence.name);
    expect(pick?.why).toContain("we'll ask you to move to Pro; nothing stops working");
  });

  it("describes the Data Health list of costs not on a job", () => {
    for (const costs of ["sometimes", "rarely"]) {
      const text = notesFor({ costs }).map((n) => n.text).join(" ");
      expect(text).toContain("lists each cost from the last 12 months that isn't on a job, biggest first");
    }
  });

  it("costs labor at each time entry's cost rate and says each employee needs one", () => {
    const text = notesFor({ labor: "time" })[0].text;
    expect(text).toContain("cost rate on each entry");
    expect(text).toContain("Each employee needs a cost rate there for their time to count");
    expect(text).toMatch(/already include it, leave the burden at 0/);
  });

  it("only promises one customer per job is picked up when there are no Projects or sub-customers", () => {
    const text = notesFor({ jobs: "customers" })[0].text;
    expect(text).toContain("have no Projects or sub-customers");
  });

  it("never calls the QuickBooks rate a pay rate or wages", () => {
    const every = [
      ...QUESTIONS.flatMap((q) => [q.q, ...q.options.map((o) => o.label)]),
      ...QUESTIONS.flatMap((q) => q.options.flatMap((o) => notesFor({ [q.id]: o.value }).map((n) => n.text))),
    ].join(" ");
    expect(every).not.toMatch(/pay rate|wages only/i);
  });
});

describe("labor burden and cost rate wording", () => {
  it("tells contractors to check their cost rates before adding a burden", () => {
    const settings = flat("app/dashboard/settings/SettingsForm.tsx");
    expect(settings).toContain("Check your employees&apos; cost rates in QuickBooks first.");
    expect(settings).toContain("If they already include these, leave this at 0, or labor is counted twice.");
    expect(settings).not.toMatch(/wages only/i);
  });

  it("uses cost rate, not pay rate, everywhere customers read it", () => {
    const files = [
      "app/dashboard/settings/SettingsForm.tsx",
      "app/(marketing)/how-it-works/page.tsx",
      "app/(marketing)/pricing/page.tsx",
      "app/(marketing)/page.tsx",
      "app/(marketing)/privacy/page.tsx",
      "app/(marketing)/security/page.tsx",
      "components/marketing/FitCheck.tsx",
      // In the app, and what the sync and the brief write.
      "components/dashboard/DataHealthSummary.tsx",
      "app/dashboard/data-health/page.tsx",
      "app/dashboard/jobs/[jobId]/page.tsx",
      "app/reports/wip/page.tsx",
      "lib/quickbooksSync.ts",
      "lib/digest.ts",
      "lib/qboCheck.ts",
      "lib/profitability.ts",
    ];
    for (const f of files) expect({ f, payRate: /pay rate|wages only/i.test(read(f)) }).toEqual({ f, payRate: false });
    expect(PLANS.profit_intelligence.marketingFeatures.join(" ")).not.toMatch(/pay rate/i);
  });
});

describe("alert claims match the nightly alert", () => {
  it("says more than 10% over the estimate, after the nightly sync", () => {
    const bullet = PLANS.profit_intelligence.marketingFeatures.find((f) => f.includes("email alerts"))!;
    expect(bullet).toContain("after the nightly sync");
    expect(bullet).toContain("more than 10% over its estimate");
    for (const f of ["app/(marketing)/page.tsx", "app/(marketing)/how-it-works/page.tsx", "app/(marketing)/pricing/page.tsx"]) {
      const text = flat(f);
      expect(text).not.toMatch(/as soon as an open job goes over|the day a job goes over|emails you when a job goes over/);
      expect(text).toContain("10% over its estimate");
    }
  });
});

describe("legal pages", () => {
  const terms = flat("app/(marketing)/terms/page.tsx");
  const privacy = flat("app/(marketing)/privacy/page.tsx");
  const security = flat("app/(marketing)/security/page.tsx");

  it("lets a Firm account serve its clients despite the no-service-to-others rule", () => {
    expect(terms).toContain(
      "except that a {firm.name} account may use the Service to serve the clients whose QuickBooks companies it connects, as Section 2 describes"
    );
  });

  it("states the referral qualification the code applies", () => {
    // src/lib/referrals.ts qualifyDueReferrals: 30 days after the first
    // payment, the first renewal paid, still active and not cancelling.
    expect(terms).toContain("have passed since their first payment, their first monthly renewal has been paid");
    expect(terms).toContain("still active and not set to cancel");
  });

  it("says Firm moves are by email and the trial includes client logins", () => {
    expect(terms).toContain("To move to or from the {firm.name} plan, email <SupportEmail />");
    expect(terms).toContain("plus the view-only client logins of the {firm.name} plan");
  });

  it("carries the new date", () => {
    expect(read("components/marketing/Legal.tsx")).toContain('LEGAL_LAST_UPDATED = "September 28, 2026"');
  });

  it("lists the QuickBooks data the sync keeps, and covers Firm accounts", () => {
    for (const phrase of [
      "classes (including class names)",
      "what is still owed on each open invoice",
      "from deposits and journal entries",
      "amount, quantity, cost category and the purchase cost",
      "aren&rsquo;t tagged to any job",
      'title="Firm accounts"',
    ]) {
      expect({ phrase, found: privacy.includes(phrase) }).toEqual({ phrase, found: true });
    }
  });

  it("agrees between Security and Privacy on what outlives a deleted account", () => {
    for (const page of [privacy, security]) {
      expect(page).toContain("commission records for payments you made");
      expect(page).toMatch(/record that a referral link led to an account is (also )?kept with your account removed from it/);
      expect(page).toMatch(/free trial/);
      expect(page).toMatch(/Stripe keeps its own records? of your payments/);
    }
    expect(security).not.toContain("Two kinds of record outlive");
  });

  it("names Classes where the job setups are listed", () => {
    expect(security).toContain("Classes if each job is a class");
    expect(flat("app/(marketing)/pricing/page.tsx")).toContain("or a Class if each job is a class");
  });
});

describe("client logins and bookkeepers", () => {
  it("describes what a client login sees without claiming it sees nothing else", () => {
    const bullet = PLANS.firm.marketingFeatures.find((f) => f.startsWith("View-only logins"))!;
    expect(bullet).toContain("dashboard, Data Health and WIP report");
    expect(bullet).toContain("can't change anything");
    expect(flat("app/(marketing)/security/page.tsx")).not.toContain("and nothing else");
  });

  it("points bookkeepers with 2 or 3 clients to Pro in the plan guide", () => {
    const guide = flat("components/marketing/PlanGuide.tsx");
    expect(guide).toContain("bookkeepers with 2 or 3 contractor clients");
    expect(guide).not.toContain("A bookkeeping or accounting firm with contractor clients, or more than");
  });

  it("no longer says connecting a client's company moves it out of their account", () => {
    const partners = flat("app/(marketing)/partners/page.tsx");
    expect(partners).not.toContain("moves it to your account");
    expect(partners).toContain(
      "If a client has already connected theirs, they disconnect it in their own account first, and then you connect it to yours."
    );
  });

  it("writes partner tier ranges with 'to', not a hyphen", () => {
    for (const t of PARTNER_TIERS) expect(t.label).not.toMatch(/\d-\d|\+/);
  });
});

describe("example data", () => {
  it("only judges finished jobs against the target in the job list preview", () => {
    const preview = read("components/marketing/ProductPreview.tsx");
    // The one job the attention table says is below target is a finished one.
    expect(preview).toMatch(/Oakfield Warehouse Fit-Out", status: "Completed"/);
    const openRows = preview.split("\n").filter((l) => l.includes('status: "Active"'));
    for (const row of openRows) expect(row).not.toMatch(/[Tt]arget/);
  });
});

describe("share image", () => {
  it("has one, named in the metadata", () => {
    expect(OG_IMAGE.url).toBe("/og-image.png");
    expect(existsSync(join(ROOT, "public", "og-image.png"))).toBe(true);
    const appFiles = readdirSync(join(SRC, "app")).filter((n) => /^(opengraph|twitter)-image\./.test(n));
    expect(appFiles).toEqual([]);
  });
});

describe("no em or en dashes in the website, legal and settings copy", () => {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(tsx?|md)$/.test(name)) files.push(full);
    }
  };
  walk(join(SRC, "app", "(marketing)"));
  walk(join(SRC, "components", "marketing"));
  walk(join(SRC, "app", "dashboard", "partner"));
  files.push(
    join(SRC, "lib", "plans.ts"),
    join(SRC, "app", "layout.tsx"),
    join(SRC, "app", "dashboard", "settings", "SettingsForm.tsx")
  );

  it("finds the files", () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it("uses none", () => {
    const withDashes = files.filter((f) => /[\u2013\u2014]|&mdash;|&ndash;/.test(readFileSync(f, "utf8")));
    expect(withDashes).toEqual([]);
  });

  it("doesn't write an error as 'Network error - please try again'", () => {
    const hyphenated = files.filter((f) => readFileSync(f, "utf8").includes("error - please"));
    expect(hyphenated).toEqual([]);
  });
});

describe("homepage pricing heading", () => {
  it("counts the plans the paragraph under it describes, Firm included", () => {
    const home = flat("app/(marketing)/page.tsx");
    const pricing = home.match(/eyebrow="Pricing" title="([^"]+)" intro="([^"]+)"/);
    expect(pricing).not.toBeNull();
    const [, title, intro] = pricing!;
    expect(intro).toContain("Firm plan");
    expect(title).not.toMatch(/\btwo plans\b|\bboth\b/i);
    expect(title).toMatch(/^Three plans\./);
  });
});
