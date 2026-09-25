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

/** Label of a BUILT-IN type. Pages that know the company use labelForJobType with its own list. */
export function jobTypeLabel(value: string | null | undefined): string {
  if (!value) return "Not set";
  return JOB_TYPE_OPTIONS.find((o) => o.value === value)?.label ?? value;
}

// ---------------------------------------------------------------------------
// A company's own list
// ---------------------------------------------------------------------------

/** One JobType row, as stored (see prisma/schema.prisma). */
export interface JobTypeRow {
  key: string;
  label: string;
  hidden: boolean;
  sortOrder: number;
}

/** A job type as a company sees it. */
export interface CompanyJobType {
  value: string;
  label: string;
  /** Hidden types stay on the jobs that have them but aren't offered for new ones. */
  hidden: boolean;
  builtIn: boolean;
}

export const BUILT_IN_JOB_TYPE_KEYS = JOB_TYPE_OPTIONS.map((o) => o.value).filter(Boolean);

/**
 * The company's job types: the built-in list with the company's renames and
 * hides applied, then the types it added, in the order it added them.
 */
export function resolveJobTypes(rows: JobTypeRow[]): CompanyJobType[] {
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const builtIn: CompanyJobType[] = JOB_TYPE_OPTIONS.filter((o) => o.value).map((o) => {
    const r = byKey.get(o.value);
    return { value: o.value, label: r?.label?.trim() || o.label, hidden: r?.hidden ?? false, builtIn: true };
  });
  const custom: CompanyJobType[] = rows
    .filter((r) => !BUILT_IN_JOB_TYPE_KEYS.includes(r.key))
    .sort((a, b) => a.sortOrder - b.sortOrder || a.label.localeCompare(b.label))
    .map((r) => ({ value: r.key, label: r.label, hidden: r.hidden, builtIn: false }));
  return [...builtIn, ...custom];
}

/** A job type's label from a company's list; an unknown key shows as itself rather than vanishing. */
export function labelForJobType(types: CompanyJobType[], value: string | null | undefined): string {
  if (!value) return "Not set";
  return types.find((t) => t.value === value)?.label ?? jobTypeLabel(value);
}

/** The types offered in pickers: everything not hidden. */
export function selectableJobTypes(types: CompanyJobType[]): CompanyJobType[] {
  return types.filter((t) => !t.hidden);
}

export const MAX_JOB_TYPE_LABEL = 40;
export const MAX_CUSTOM_JOB_TYPES = 40;

/** Tidies a label typed by the contractor. Returns null when nothing usable is left. */
export function cleanJobTypeLabel(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const label = raw.replace(/\s+/g, " ").trim().slice(0, MAX_JOB_TYPE_LABEL);
  return label.length > 0 ? label : null;
}

/**
 * The stored key for a new type: "c_" plus a slug of its label, made unique.
 * Keys never change after this, so renaming a type never touches its jobs.
 */
export function customJobTypeKey(label: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 30) || "type";
  let key = `c_${slug}`;
  for (let i = 2; used.has(key); i++) key = `c_${slug}_${i}`;
  return key;
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
  /** Where the word was found. */
  source?: "name" | "estimate";
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const hasWord = (text: string, word: string) => new RegExp(`(^|[^a-z0-9])${escapeRe(word)}([^a-z0-9]|$)`).test(text);

/** Words too general to identify a type on their own ("Kitchen remodel" is identified by "kitchen"). */
const GENERIC_WORDS = new Set([
  "remodel", "remodels", "remodeling", "renovation", "renovations", "job", "jobs", "work", "project", "projects",
  "install", "installs", "installation", "repair", "repairs", "service", "new", "the", "and", "of", "for", "other", "general", "misc",
]);

function distinctiveWords(label: string): string[] {
  return label
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !GENERIC_WORDS.has(w));
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
export function suggestJobType(jobName: string | null | undefined, types?: CompanyJobType[]): JobTypeSuggestion | null {
  if (!jobName) return null;
  const name = jobName.toLowerCase();

  // A company's own types first, and the most specific first: with
  // "Kitchen remodel" added, "Smith Kitchen" is a kitchen remodel, not the
  // built-in Remodel. Every distinctive word of the label must appear
  // (plural or singular).
  if (types) {
    const custom = types
      .filter((t) => !t.builtIn && !t.hidden)
      .map((t) => ({ t, words: distinctiveWords(t.label) }))
      .filter((c) => c.words.length > 0)
      .sort((a, b) => b.words.length - a.words.length);
    for (const { t, words } of custom) {
      const found = words.map((w) => (hasWord(name, w) ? w : w.endsWith("s") && hasWord(name, w.slice(0, -1)) ? w.slice(0, -1) : hasWord(name, `${w}s`) ? `${w}s` : null));
      if (found.every(Boolean)) return { value: t.value, label: t.label, matchedOn: found.join(" "), source: "name" };
    }
  }

  const offered = types ? new Map(types.filter((t) => !t.hidden).map((t) => [t.value, t.label])) : null;
  for (const rule of RULES) {
    if (offered && !offered.has(rule.value)) continue;
    for (const keyword of rule.keywords) {
      // Word-boundary match on the keyword, escaped so a keyword containing
      // a hyphen or space can't be read as regex syntax.
      if (hasWord(name, keyword)) {
        return { value: rule.value, label: offered?.get(rule.value) ?? jobTypeLabel(rule.value), matchedOn: keyword, source: "name" };
      }
    }
  }
  return null;
}

/**
 * The same rules applied to the products and services on a job's QuickBooks
 * estimates, for jobs whose names say nothing ("Smith Residence"). Only used
 * when one type accounts for most of the estimate's value, because a remodel
 * estimate routinely has an electrical or plumbing line on it.
 */
export function suggestJobTypeFromEstimateLines(
  lines: { name: string | null; amount: number }[],
  types?: CompanyJobType[]
): JobTypeSuggestion | null {
  const total = lines.reduce((s, l) => s + Math.max(0, l.amount), 0);
  if (total <= 0) return null;
  const byType = new Map<string, { amount: number; s: JobTypeSuggestion }>();
  for (const l of lines) {
    if (!l.name || l.amount <= 0) continue;
    const s = suggestJobType(l.name, types);
    if (!s) continue;
    const cur = byType.get(s.value) ?? { amount: 0, s };
    cur.amount += l.amount;
    byType.set(s.value, cur);
  }
  const best = [...byType.values()].sort((a, b) => b.amount - a.amount)[0];
  if (!best || best.amount / total < 0.6) return null;
  return { ...best.s, source: "estimate" };
}
