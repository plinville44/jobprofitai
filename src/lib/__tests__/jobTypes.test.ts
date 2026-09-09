import { describe, it, expect } from "vitest";
import { JOB_TYPE_OPTIONS, jobTypeLabel, suggestJobType } from "../jobTypes";

describe("suggestJobType", () => {
  it("recognises the obvious ones from a job name", () => {
    expect(suggestJobType("Torres Kitchen Remodel")?.value).toBe("remodel");
    expect(suggestJobType("Harborview Roof Replacement")?.value).toBe("roofing");
    expect(suggestJobType("Riverside HVAC Retrofit")?.value).toBe("hvac");
    expect(suggestJobType("Ruiz Bathroom Refresh")?.value).toBe("remodel");
    expect(suggestJobType("Miller exterior paint")?.value).toBe("painting");
    expect(suggestJobType("Unit 4 repipe")?.value).toBe("plumbing");
    expect(suggestJobType("Shore Rd new construction")?.value).toBe("new_construction");
  });

  it("puts the trade ahead of the generic remodel words", () => {
    // "Bathroom repipe" is plumbing work. Grouping it with kitchen remodels
    // would put it in a comparison it doesn't belong in, and the resulting
    // pattern would be shown to a contractor as a finding about their
    // business.
    expect(suggestJobType("Bathroom repipe")?.value).toBe("plumbing");
    expect(suggestJobType("Kitchen rewire")?.value).toBe("electrical");
  });

  it("matches on whole words only", () => {
    // "Jackson" contains "ac", "painstaking" contains "paint", and
    // "Brooflyn" is a typo that shouldn't become a roofing job.
    expect(suggestJobType("Jackson residence")).toBeNull();
    expect(suggestJobType("Painstaking Detail LLC")).toBeNull();
  });

  it("returns null rather than guessing", () => {
    // A wrong job type is worse than a blank one, so anything that isn't a
    // clear match stays unset for the customer to choose.
    expect(suggestJobType("Fence Install - Sample St")).toBeNull();
    expect(suggestJobType("0969 Ocean View Road")).toBeNull();
    expect(suggestJobType("Barnett Design")).toBeNull();
    expect(suggestJobType("55 Twin Lane")).toBeNull();
    expect(suggestJobType("")).toBeNull();
    expect(suggestJobType(null)).toBeNull();
  });

  it("is case insensitive and reports what it matched on", () => {
    const s = suggestJobType("SHINGLE replacement, north side");
    expect(s?.value).toBe("roofing");
    expect(s?.matchedOn).toBe("shingle");
    expect(s?.label).toBe("Roofing");
  });

  it("only ever suggests a value the dropdown actually offers", () => {
    // The suggester and the form share this list precisely so a suggestion
    // can't be un-selectable.
    const allowed = new Set(JOB_TYPE_OPTIONS.map((o) => o.value));
    const names = [
      "Kitchen Remodel",
      "Roof tear-off",
      "Furnace swap",
      "Panel upgrade",
      "Sewer line",
      "Repaint hallway",
      "New home build",
    ];
    for (const name of names) {
      const s = suggestJobType(name);
      if (s) expect(allowed.has(s.value)).toBe(true);
    }
  });
});

describe("jobTypeLabel", () => {
  it("renders a stored value as its human label", () => {
    expect(jobTypeLabel("new_construction")).toBe("New Construction");
    expect(jobTypeLabel(null)).toBe("Not set");
    expect(jobTypeLabel("")).toBe("Not set");
  });

  it("falls back to the raw value rather than hiding an unknown one", () => {
    expect(jobTypeLabel("excavation")).toBe("excavation");
  });
});
