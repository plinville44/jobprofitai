import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import {
  CONSENT_DENIED_REGIONS,
  TAGGED_PATHS,
  cookieDomainsFor,
  gpcOn,
  gtmBootstrap,
  leavesTaggedPages,
  marketingCookieNames,
  optedOutByCookie,
  tagsAllowedOnPath,
  trackingAllowed,
} from "@/lib/tracking";

// The Privacy Policy, the Security page and Your Privacy Choices promise that
// the analytics and advertising tags run only on public pages, never in the
// app, and never after an opt-out or a Global Privacy Control signal. These
// tests hold src/lib/tracking.ts, the loader and the pages to those promises.

const SRC = join(__dirname, "..", "..");
const read = (rel: string) => readFileSync(join(SRC, rel), "utf8");
const flat = (rel: string) => read(rel).replace(/\s+/g, " ");

/** Every page route under a folder, as a URL path ("(group)" folders drop out, "[param]" becomes "x"). */
function pageRoutes(dirRel: string, base: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, url: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (!statSync(full).isDirectory()) {
        if (name === "page.tsx") out.push(url === "" ? "/" : url);
        continue;
      }
      const segment = name.startsWith("(") ? "" : `/${name.replace(/^\[.*\]$/, "x")}`;
      walk(full, url + segment);
    }
  };
  walk(join(SRC, dirRel), base);
  return out;
}

describe("where the tags may run", () => {
  it("allows the public pages, the ad landing pages and signup", () => {
    for (const path of ["/", "/pricing", "/pricing/", "/how-it-works", "/demo", "/lp/wip", "/lp/pricing", "/signup", "/privacy-choices"]) {
      expect({ path, allowed: tagsAllowedOnPath(path) }).toEqual({ path, allowed: true });
    }
  });

  it("never allows the app, login, password or invitation pages", () => {
    for (const path of [
      "/dashboard",
      "/dashboard/jobs/abc",
      "/dashboard/billing",
      "/dashboard/settings",
      "/dashboard/admin",
      "/reports/wip",
      "/login",
      "/login/intuit",
      "/forgot-password",
      "/reset-password",
      "/invite/abc",
      "/verify-email",
      "/quickbooks/disconnected",
      "/api/contact",
      "/lp",
    ]) {
      expect({ path, allowed: tagsAllowedOnPath(path) }).toEqual({ path, allowed: false });
    }
  });

  it("has made a decision for every public page, and tags none of the app's pages", () => {
    const marketing = pageRoutes("app/(marketing)", "");
    expect(marketing.length).toBeGreaterThan(8);
    for (const path of marketing) {
      expect({ path, listed: (TAGGED_PATHS as readonly string[]).includes(path) }).toEqual({ path, listed: true });
    }
    for (const path of pageRoutes("app/lp", "/lp")) {
      if (path === "/lp") continue;
      expect({ path, allowed: tagsAllowedOnPath(path) }).toEqual({ path, allowed: true });
    }
    const app = [...pageRoutes("app/dashboard", "/dashboard"), ...pageRoutes("app/reports", "/reports")];
    expect(app.length).toBeGreaterThan(10);
    for (const path of app) {
      expect({ path, allowed: tagsAllowedOnPath(path) }).toEqual({ path, allowed: false });
    }
  });
});

describe("opt-out and Global Privacy Control", () => {
  it("stops the tags for a GPC signal or the opt-out cookie", () => {
    expect(trackingAllowed({ gpc: false, cookieHeader: "" })).toBe(true);
    expect(trackingAllowed({ gpc: true, cookieHeader: "" })).toBe(false);
    expect(trackingAllowed({ gpc: false, cookieHeader: "a=1; jpai_optout=1; b=2" })).toBe(false);
    expect(optedOutByCookie("jpai_optout=0")).toBe(false);
    expect(gpcOn({ globalPrivacyControl: true })).toBe(true);
    expect(gpcOn({ globalPrivacyControl: "1" })).toBe(false);
    expect(gpcOn(undefined)).toBe(false);
  });

  it("clears the tags' first-party cookies, and never the ones the Service needs", () => {
    const names = marketingCookieNames(
      "_ga=1; _ga_ABC123=2; _gcl_au=3; _gcl_aw=4; jpai_src=5; li_fat_id=6; jmai_session=7; jpai_ref=8; jpai_company=9; jpai_optout=1"
    );
    expect(names).toEqual(["_ga", "_ga_ABC123", "_gcl_au", "_gcl_aw", "jpai_src", "li_fat_id"]);
    expect(cookieDomainsFor("www.jobprofitai.com")).toEqual(["www.jobprofitai.com", "jobprofitai.com"]);
  });
});

describe("the GTM loader", () => {
  it("injects nothing without a valid container ID", () => {
    expect(gtmBootstrap("")).toBeNull();
    expect(gtmBootstrap("GTM-ABC123');alert(1);//")).toBeNull();
    expect(gtmBootstrap("UA-12345")).toBeNull();
  });

  it("sets Consent Mode to denied for the EEA, UK and Switzerland before GTM loads", () => {
    const script = gtmBootstrap("GTM-ABC1234")!;
    for (const region of ["DE", "FR", "IE", "NO", "GB", "CH"]) {
      expect(script).toContain(`'${region}'`);
    }
    expect(CONSENT_DENIED_REGIONS.length).toBe(32);
    const denied = script.indexOf("ad_storage:'denied'");
    const load = script.indexOf("googletagmanager.com/gtm.js");
    expect(denied).toBeGreaterThan(-1);
    expect(denied).toBeLessThan(load);
    expect(script).toContain("'GTM-ABC1234'");
  });

  it("treats a move into the app as leaving the tagged pages, and other sites not at all", () => {
    const here = "https://jobprofitai.com/pricing";
    expect(leavesTaggedPages(here, "/dashboard")).toBe(true);
    expect(leavesTaggedPages(here, "https://jobprofitai.com/login")).toBe(true);
    expect(leavesTaggedPages(here, "/how-it-works")).toBe(false);
    expect(leavesTaggedPages(here, "/lp/wip?utm_source=x")).toBe(false);
    expect(leavesTaggedPages(here, "https://example.com/dashboard")).toBe(false);
    expect(leavesTaggedPages(here, null)).toBe(false);
  });

  it("wraps history before GTM loads and catches Back first", () => {
    const loader = flat("components/MarketingTags.tsx");
    expect(loader.indexOf("guardLeavingTaggedPages();")).toBeLessThan(loader.indexOf('document.createElement("script")'));
    expect(loader).toContain("event.stopImmediatePropagation();");
    expect(loader).toContain('"popstate"');
  });

  it("is mounted in the root layout, checks the rules, and reloads when leaving tagged pages", () => {
    expect(read("app/layout.tsx")).toContain("<MarketingTags />");
    const loader = flat("components/MarketingTags.tsx");
    expect(loader).toContain("tagsAllowedOnPath(pathname)");
    expect(loader).toContain("trackingAllowed(");
    expect(loader).toContain("if (!allowedHere && !window.__jpaiLeaving) {");
    expect(loader).toContain("window.location.assign(pathname);");
  });
});

describe("what the pages promise", () => {
  const privacy = flat("app/(marketing)/privacy/page.tsx");

  it("discloses Google Analytics and Google Ads the way Google's terms ask, and what isn't used", () => {
    for (const phrase of [
      "https://policies.google.com/technologies/partner-sites",
      "How Google uses information from sites or apps that use its services",
      "https://adssettings.google.com",
      "https://tools.google.com/dlpage/gaoptout",
      "We don&rsquo;t use remarketing",
      "Google signals and personalized advertising are turned off",
    ]) {
      expect({ phrase, found: privacy.includes(phrase) }).toEqual({ phrase, found: true });
    }
    // Not running at launch. Adding any of them means adding its disclosure first.
    for (const phrase of ["LinkedIn Insight Tag", "Enhanced conversions:", "li_sugr"]) {
      expect({ phrase, found: privacy.includes(phrase) }).toEqual({ phrase, found: false });
    }
  });

  it("discloses the demo videos the way the player loads them", () => {
    // DemoVideo.tsx shows our own picture until play, then plays our own file
    // from Vercel Blob. Nothing on the website loads from YouTube.
    for (const phrase of [
      '<LegalSub title="Videos">',
      "It plays from our own website: the video files are stored with Vercel, our hosting provider, and nothing on our website loads from YouTube.",
      "the video downloads only when you play it",
      "YouTube if you open one of our videos there",
    ]) {
      expect({ phrase, found: privacy.includes(phrase) }).toEqual({ phrase, found: true });
    }
    expect(privacy).not.toContain("youtube-nocookie");
    expect(privacy).not.toContain("YouTube may store its own cookies");
    const player = flat("components/marketing/DemoVideo.tsx");
    expect(player).toContain('preload="none"');
    expect(player).not.toMatch(/iframe|youtube/i);
    expect(flat("lib/demoVideo.ts")).not.toMatch(/youtube-nocookie|youtube\.com\/embed/);
  });

  it("sends video plays only to tags that are already running", () => {
    // The GTM loader creates window.dataLayer; the player never does.
    const player = flat("components/marketing/DemoVideo.tsx");
    expect(player).toContain("if (Array.isArray(layer)) layer.push({ event, video_title: video.title");
    expect(player).not.toMatch(/dataLayer\s*=|dataLayer\s*\|\|/);
  });

  it("lists every cookie, says where the tags run, and covers GPC and Do Not Track", () => {
    for (const cookie of ["jmai_session", "jpai_ref", "jpai_company", "jpai_optout", "jpai_src", "_gcl_au"]) {
      expect({ cookie, listed: privacy.includes(cookie) }).toEqual({ cookie, listed: true });
    }
    expect(privacy).toContain(">_ga</span>");
    expect(privacy).toContain("They never run inside the JobProfitAI app");
    expect(privacy).toContain("Global Privacy Control and Do Not Track");
    expect(privacy).toContain("we don&rsquo;t respond to it");
  });

  it("no longer says there is no analytics or advertising", () => {
    expect(privacy).not.toContain("We do not use analytics, advertising or tracking services");
    expect(privacy).not.toContain("nothing to opt out of");
    expect(privacy).not.toContain("all first-party and all needed for the Service to work");
    expect(flat("app/(marketing)/terms/page.tsx")).not.toContain("we do not use it to advertise to you or anyone else");
  });

  it("covers outreach: where contact details come from, who handles them, and how to stop it", () => {
    for (const phrase of ["Apollo.io", "LinkedIn Sales Navigator", "HubSpot, Inc.", "Contractors who help with outreach", "do-not-contact list", "within 10 business days"]) {
      expect({ phrase, found: privacy.includes(phrase) }).toEqual({ phrase, found: true });
    }
  });

  it("links Your Privacy Choices from every footer, and the page shows a GPC signal was honored", () => {
    expect(read("components/marketing/SiteFooter.tsx")).toContain('href: "/privacy-choices"');
    expect(read("app/lp/layout.tsx")).toContain('href="/privacy-choices"');
    expect(read("app/sitemap.ts")).toContain('"/privacy-choices"');
    expect(flat("components/marketing/PrivacyChoices.tsx")).toContain("Global Privacy Control signal received and honored");
  });

  it("keeps the Terms' example-data and partner disclosure rules", () => {
    const terms = flat("app/(marketing)/terms/page.tsx");
    expect(terms).toContain("come from a made-up example company");
    expect(terms).toContain("you must clearly tell people that you may earn a credit or commission");
    expect(terms).toContain("bid on JobProfitAI or similar names as keywords in search ads");
  });

  it("says on the Security page that the tags stay out of the app", () => {
    expect(flat("app/(marketing)/security/page.tsx")).toContain("Advertising and analytics tags stay out of the app");
  });
});
