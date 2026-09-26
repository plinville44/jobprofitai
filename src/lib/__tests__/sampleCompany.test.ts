import { describe, expect, it } from "vitest";
import { getSampleCompany } from "../sampleCompany";

// The marketing site and /demo render this invented company through the
// real engine. These checks keep the story the site tells intact if the
// engine changes, and keep its copy within the house style.
describe("sample company shown on the website", () => {
  const s = getSampleCompany();

  it("has each kind of opportunity the site shows", () => {
    const kinds = s.feed.items.map((i) => `${i.kind}:${i.id.split(":")[1] ?? ""}`);
    expect(kinds).toContain("estimate_below_target:e1043");
    expect(kinds).toContain("job_type_pricing:c_kitchen");
    expect(kinds).toContain("customer_pricing:Brightline Builders");
    expect(kinds).toContain("open_job_over_estimate:o1");
    expect(kinds).toContain("strong_job_type:c_bath");
    const kitchen = s.feed.items.find((i) => i.id === "job_type_pricing:c_kitchen")!;
    expect(kitchen.cause).toMatch(/^The thin part is labor/);
    expect(s.tracked.subjectLabel).toBe("Roofing");
    // The tracked change is already reflected: roofing has no pricing item now.
    expect(s.feed.items.some((i) => i.id === "job_type_pricing:roofing")).toBe(false);
    expect(s.feed.items[0].kind).toBe("estimate_below_target");
  });

  it("shows a pending estimate below target and a change that worked", () => {
    const e = s.estimates.find((x) => x.id === "e1043")!;
    expect(e.check.status).toBe("below_target");
    expect(e.check.method).toBe("by_part");
    expect(s.estimates.find((x) => x.id === "e1045")!.check.status).toBe("on_target");
    expect(s.tracked.outcome.status).toBe("measured");
    expect(s.tracked.outcome.extraProfit!).toBeGreaterThan(0);
  });

  it("uses no em or en dashes anywhere a visitor reads", () => {
    const text = JSON.stringify([s.feed, s.estimates.map((e) => e.check), s.tracked]);
    expect(/[–—]/.test(text)).toBe(false);
  });
});
