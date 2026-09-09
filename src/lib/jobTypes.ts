// Job type: the one field QuickBooks cannot supply.
//
// QBO has no concept of "this is a roofing job". It is the field every
// cross-job comparison groups by, and it is set by hand, which makes it the
// most common reason a new customer sees an empty Profit Opportunities page
// after a clean sync. Suggesting it from the job name removes most of that
// work without ever guessing on the customer's behalf.
//
// The options live here rather than in the form component so the suggester
// and the dropdown cannot drift apart.

export interface JobTypeOption {
  value: string;
  label: string;
}

export const JOB_TYPE_OPTIONS: JobTypeOption[] = [
  { value: "", label: "Not set" },
  { value: "roofing", label: "Roofing" },
  { value: "remodel", label: "Remodel" },
  { value: "new_construction", label: "New Construction" },
  { value: "painting", label: "Painting" },
  { value: "plumbing", label: "Plumbing" },
  { value: "electrical", label: "Electrical" },
  { value: "hvac", label: "HVAC" },
  { value: "general", label: "General Contracting" },
  { value: "other", label: "Other" },
];

export function jobTypeLabel(value: string | null | undefined): string {
  if (!value) return "Not set";
  return JOB_TYPE_OPTIONS.find((o) => o.value === value)?.label ?? value;
}

/**
 * Keyword rules, most specific trade first.
 *
 * Order matters: "Bathroom repipe" is a plumbing job, not a remodel, so the
 * trades are checked before the generic remodel words. Within a rule the
 * keywords are matched on word boundaries, so "ac" never matches "Jackson"
 * and "paint" never matches "painstaking".
 *
 * Deliberately incomplete. "Fence Install", "Deck Addition" and "Site Prep"
 * are left unmatched rather than pushed into General Contracting, because a
 * wrong job type is worse than a blank one: it silently puts a job into a
 * comparison group it does not belong in, and the resulting pattern would be
 * presented to a contractor as a finding about their business.
 */
const RULES: { value: string; keywords: string[] }[] = [
  { value: "roofing", keywords: ["roof", "roofing", "reroof", "re-roof", "shingle", "shingles", "gutter", "gutters"] },
  { value: "hvac", keywords: ["hvac", "furnace", "heat pump", "mini split", "mini-split", "ductwork", "duct work", "air conditioning", "air conditioner"] },
  { value: "electrical", keywords: ["electrical", "electric", "rewire", "rewiring", "panel upgrade", "wiring"] },
  { value: "plumbing", keywords: ["plumbing", "plumber", "repipe", "re-pipe", "water heater", "sewer", "drain line", "drain lines"] },
  { value: "painting", keywords: ["paint", "painting", "repaint", "exterior paint", "interior paint"] },
  { value: "new_construction", keywords: ["new construction", "new build", "new home", "spec home", "ground up", "ground-up"] },
  { value: "remodel", keywords: ["remodel", "remodeling", "renovation", "renovate", "reno", "kitchen", "bathroom", "bath", "basement", "refresh", "fit-out", "fit out", "retrofit"] },
];

export interface JobTypeSuggestion {
  value: string;
  label: string;
  /** The word in the job name that produced this suggestion. */
  matchedOn: string;
}

/**
 * Suggests a job type from a job name, or returns null when nothing matches
 * clearly.
 *
 * This is a SUGGESTION. Nothing in the app writes it automatically. The
 * customer confirms it, because the value feeds benchmarking and profit
 * opportunity rules, and a number derived from a guess we made silently is
 * exactly the kind of false precision this product is supposed to avoid.
 */
export function suggestJobType(jobName: string | null | undefined): JobTypeSuggestion | null {
  if (!jobName) return null;
  const name = jobName.toLowerCase();

  for (const rule of RULES) {
    for (const keyword of rule.keywords) {
      // Word-boundary match on the keyword, escaped so a keyword containing
      // a hyphen or space can't be read as regex syntax.
      const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`).test(name)) {
        return { value: rule.value, label: jobTypeLabel(rule.value), matchedOn: keyword };
      }
    }
  }
  return null;
}
