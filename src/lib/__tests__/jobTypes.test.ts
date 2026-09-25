import { describe, it, expect } from "vitest";
import {
  JOB_TYPE_OPTIONS,
  cleanJobTypeLabel,
  customJobTypeKey,
  jobTypeLabel,
  labelForJobType,
  resolveJobTypes,
  selectableJobTypes,
  suggestJobType,
  suggestJobTypeFromEstimateLines,
} from "../jobTypes";

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

describe("a company's own job types", () => {
  const types = resolveJobTypes([
    { key: "remodel", label: "Remodels", hidden: false, sortOrder: 0 },
    { key: "hvac", label: "HVAC", hidden: true, sortOrder: 0 },
    { key: "c_kitchen_remodel", label: "Kitchen remodel", hidden: false, sortOrder: 1 },
    { key: "c_deck", label: "Decks", hidden: false, sortOrder: 0 },
  ]);

  it("keeps the built-in list, applies renames and hides, then adds the company's own", () => {
    expect(types.find((t) => t.value === "remodel")?.label).toBe("Remodels");
    expect(types.find((t) => t.value === "hvac")?.hidden).toBe(true);
    expect(types.filter((t) => !t.builtIn).map((t) => t.value)).toEqual(["c_deck", "c_kitchen_remodel"]);
    expect(selectableJobTypes(types).some((t) => t.value === "hvac")).toBe(false);
    expect(labelForJobType(types, "hvac")).toBe("HVAC");
    expect(labelForJobType(types, "gone_key")).toBe("gone_key");
  });

  it("prefers the company's own, more specific type", () => {
    expect(suggestJobType("Smith Kitchen", types)?.value).toBe("c_kitchen_remodel");
    expect(suggestJobType("Oak St deck build", types)?.value).toBe("c_deck");
    expect(suggestJobType("Jones bathroom", types)?.label).toBe("Remodels");
    // Hidden types are never suggested.
    expect(suggestJobType("Furnace swap", types)).toBeNull();
  });

  it("reads the products on an estimate when one type dominates", () => {
    const lines = [
      { name: "Architectural shingles", amount: 9_000 },
      { name: "Gutters", amount: 1_500 },
      { name: "Electrical", amount: 500 },
    ];
    expect(suggestJobTypeFromEstimateLines(lines, types)).toMatchObject({ value: "roofing", source: "estimate" });
    expect(suggestJobTypeFromEstimateLines([{ name: "Shingles", amount: 1_000 }, { name: "Plumbing rough-in", amount: 1_000 }], types)).toBeNull();
  });

  it("makes stable, unique keys and tidy labels", () => {
    expect(customJobTypeKey("Kitchen Remodel!", [])).toBe("c_kitchen_remodel");
    expect(customJobTypeKey("Kitchen remodel", ["c_kitchen_remodel"])).toBe("c_kitchen_remodel_2");
    expect(cleanJobTypeLabel("  Deck   and  patio ")).toBe("Deck and patio");
    expect(cleanJobTypeLabel("   ")).toBeNull();
  });
});
