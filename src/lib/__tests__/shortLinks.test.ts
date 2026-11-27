import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { SHORT_LINKS, SHORT_LINK_FALLBACK, shortLinkTarget } from "@/lib/shortLinks";

// The short links printed in the outreach emails (Weekly Outreach Routine,
// part 4b). Changing a target here changes where live emails send people.

const SRC = join(__dirname, "..", "..");
const read = (rel: string) => readFileSync(join(SRC, rel), "utf8");
const TAG = "utm_source=email&utm_medium=outreach";

describe("outreach short links", () => {
  it("send each campaign's links to the right page with its own tag", () => {
    expect(SHORT_LINKS).toEqual({
      demo: `/demo?${TAG}&utm_campaign=owners`,
      check: `/?${TAG}&utm_campaign=owners#fit-check`,
      sample: `/demo?${TAG}&utm_campaign=office`,
      trial: `/signup?${TAG}&utm_campaign=office`,
      example: `/demo?${TAG}&utm_campaign=bookkeepers`,
      partners: `/partners?${TAG}&utm_campaign=bookkeepers`,
    });
  });

  it("ignore case and stray spaces", () => {
    expect(shortLinkTarget("Demo")).toBe(SHORT_LINKS.demo);
    expect(shortLinkTarget(" PARTNERS ")).toBe(SHORT_LINKS.partners);
  });

  it("send an unknown or empty slug to the homepage, still tagged as outreach", () => {
    for (const slug of ["", "nope", "constructor", "toString", "__proto__", undefined, null]) {
      expect({ slug, to: shortLinkTarget(slug) }).toEqual({ slug, to: SHORT_LINK_FALLBACK });
    }
    expect(SHORT_LINK_FALLBACK).toBe(`/?${TAG}`);
  });

  it("only ever point at this site", () => {
    for (const to of [...Object.values(SHORT_LINKS), SHORT_LINK_FALLBACK]) {
      expect(to.startsWith("/")).toBe(true);
      expect(to.startsWith("//")).toBe(false);
      const url = new URL(to, "https://jobprofitai.com");
      expect(url.host).toBe("jobprofitai.com");
      expect(url.searchParams.get("utm_source")).toBe("email");
      expect(url.searchParams.get("utm_medium")).toBe("outreach");
    }
  });

  it("keep the #fit-check part after the tags, where the browser needs it", () => {
    const url = new URL(shortLinkTarget("check"), "https://jobprofitai.com");
    expect(url.hash).toBe("#fit-check");
    expect(url.searchParams.get("utm_campaign")).toBe("owners");
  });

  it("forward with a temporary redirect, and stay out of search results", () => {
    const route = read("app/go/[slug]/route.ts").replace(/\s+/g, " ");
    expect(route).toContain("NextResponse.redirect(new URL(shortLinkTarget(slug), req.url), 307)");
    expect(read("app/robots.ts")).toContain('"/go/"');
  });
});
