// Deterministic guard rails around the AI-written part of the Weekly Profit
// Brief: what the model is given, and what comes back.
//
// The prompt asks for all of this. This makes it true whether or not the
// model listened, because the text goes straight into a customer's inbox.

import { formatCurrency } from "./format";

/**
 * - Drops a leading "Subject:" line. Asked for a "headline take", the model
 *   sometimes writes itself an email subject, which then arrived as the
 *   first line of the body under the real subject.
 * - Drops a leading greeting ("Hi team,"), which reads oddly beneath a
 *   deterministic section.
 * - Replaces em and en dashes. House style is no dashes as punctuation in
 *   any copy; a spaced dash becomes a comma, a bare one (a range such as
 *   "Jan to Mar" written with an en dash) becomes a hyphen.
 */
export function cleanDigestText(text: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");

  while (lines.length > 0) {
    const first = lines[0].trim();
    if (first === "" || /^subject\s*:/i.test(first) || /^(hi|hello|hey|good (morning|afternoon))\b.*,$/i.test(first)) {
      lines.shift();
      continue;
    }
    break;
  }

  return lines
    .join("\n")
    .replace(/[ \t]+[\u2014\u2013][ \t]+/g, ", ")
    .replace(/[\u2014\u2013]/g, "-")
    .trim();
}

// --- Shaping what the model is given -----------------------------------

interface VarianceFields {
  status: string;
  estimatedCost: number | null;
  actualCost: number;
  varianceVsEstimate: number | null;
  varianceVsEstimatePct: number | null;
}

/**
 * Removes "under budget" from open jobs before the model ever sees it.
 *
 * Variance is costs minus estimate, so every job in progress starts deeply
 * negative and climbs toward zero as the work gets done. Handed that number,
 * the model wrote "You're actually $3,500 under budget on costs" about a job
 * that had simply not finished spending yet - the same defect as the job page
 * praising a job with no costs for being "$12,000 under the estimate".
 *
 * Only a completed job can come in under budget. An open job that has gone
 * OVER its estimate is already over, finished or not, so a positive variance
 * is kept. For an open job still inside its estimate, the variance is
 * replaced by how much of the estimate has been spent, which is the true
 * statement: "$8,000 spent of an $11,500 estimate".
 *
 * Done here, deterministically, because a prompt rule alone is a request.
 */
export function withoutOpenJobUnderspend<T extends VarianceFields>(
  job: T
): T & { spentOfEstimatePct?: number } {
  const stillInsideEstimate =
    job.status === "open" && job.varianceVsEstimate != null && job.varianceVsEstimate <= 0;
  if (!stillInsideEstimate) return job;
  return {
    ...job,
    varianceVsEstimate: null,
    varianceVsEstimatePct: null,
    ...(job.estimatedCost ? { spentOfEstimatePct: job.actualCost / job.estimatedCost } : {}),
  };
}

// --- Checking what comes back ------------------------------------------

/** What the checker needs to know about each job the model was given. */
export interface SummaryJobFacts {
  jobName: string;
  status: string;
  /** Margin to date, as a fraction. */
  marginPct: number | null;
  /** Only when the forecast is firm enough to act on (see computeConnectionMetrics). */
  forecastMarginPct?: number | null;
  estimateSetFromTargetMargin?: boolean;
  /** The job's cost estimate, when the brief has it (estimate_said_missing). */
  estimatedCost?: number | null;
  /**
   * On an open job whose cost estimate is above its contract: what it loses
   * if costs come in at the estimate. A loss said of it is true, with or
   * without a forecast; a better finish isn't.
   */
  lossIfCostsMatchEstimate?: number;
}

export interface SummaryFacts {
  jobs: SummaryJobFacts[];
  /** "skipped": no comparison with an earlier brief this week; "changes" or "no_changes" otherwise. */
  comparison: "skipped" | "changes" | "no_changes";
  /**
   * What the model was given, word for word. A link, email address or phone
   * number in the summary that isn't in here was made up, or was planted in
   * a QuickBooks name to steer the model, so it never reaches a customer.
   */
  input?: string;
}

export type SummaryRule =
  | "forecast_without_forecast"
  | "loss_without_loss"
  | "open_job_under_budget"
  | "target_estimate_overrun"
  | "comparison_skipped"
  | "nothing_changed"
  | "contact_not_in_data"
  | "outcome_without_forecast"
  | "range_of_jobs"
  | "owner_in_third_person"
  | "estimate_said_missing";

export interface SummaryProblem {
  rule: SummaryRule;
  /** The sentence, exactly as it appears in the text. */
  sentence: string;
  jobName?: string;
  /** What's wrong, in words the model is given when asked to rewrite. */
  reason: string;
}

/** The source of NEGATING_LEAD (below), shared with OUTCOME_DOUBT. */
const NEGATING_LEAD_SRC = String.raw`\bno (?:sign|indication|evidence)s? (?:yet |so far )?that\b|(?:n['\u2019]t|\bnot) (?:yet )?far enough along to\b|(?<!\b(?:regardless|irrespective) of\s+|\bno (?:matter|longer)\s+)\bwhether\b`;

/** A word that turns the phrase after it around: "no forecast", "didn't lose money". */
const NEGATION = /\b(no|not|none|never|without|too early|cannot)\b|n['\u2019]t\b/i;

const FORECAST_WORDS =
  /\b(forecast(?:s|ing|ed)?|on track (?:to|for)|heading (?:for|toward|towards)|projected to|expected to (?:finish|close|end|land|come in))\b/gi;
const LOSS_WORDS = /\b(los(?:ing|es|t) money|lose money|money-losing|at a loss|in the red|unprofitable)\b/gi;
const UNDER_BUDGET_WORDS = /\b(under (?:its |the |their )?(?:\$[\d,.]+ )?(?:budget|estimates?)|came in under)\b/gi;
const OVERRUN_WORDS =
  /\b(over (?:its |the |their )?(?:\$[\d,.]+ )?(?:estimate|budget)|overr(?:an|un|uns|unning)|ran over|went over|gone over|exceeded (?:its |the |their )?(?:estimate|budget))\b/gi;
// Not "comparison" or "baseline" on their own: "For comparison, ..." and a
// job such as "Baseline Rd Kitchen" say nothing about this week's comparison.
const COMPARISON_WORDS =
  /\b(nothing (?:has )?changed|no changes|nothing new|(?:can['\u2019]t|cannot|couldn['\u2019]t|can not) be compared|(?:wasn['\u2019]t|weren['\u2019]t|isn['\u2019]t|aren['\u2019]t|not) compared|compared (?:to|with|against) last week)\b/i;
const NOTHING_CHANGED_WORDS = /\b(nothing (?:has )?changed|no changes|nothing new)\b/i;

/**
 * How a job will finish, said either way: "a projected loss", "not a
 * projected loss", "isn't heading for a loss", "won't lose money", "will
 * still finish profitable". Only a firm forecast can say that, so on an open
 * job without one these are wrong even when negated, unlike FORECAST_WORDS,
 * where "no forecast" says only that there isn't one. The test company's
 * preview of Oct 29, 2026 said MX04, whose cost estimate is $10,000 above
 * its contract, was "not a projected loss". Present-tense "isn't losing
 * money" isn't one of these: the prompt asks for it about an open job whose
 * costs are ahead of its billing.
 */
const OUTCOME_WORDS = new RegExp(
  [
    String.raw`\b(?:projected|expected|forecast(?:ed)?|likely|eventual|final)\s+(?:loss(?:es)?|profits?)\b`,
    String.raw`\b(?:heading|headed|on track|on course|on pace|tracking|trending|set|going|poised|projected|expected|forecast(?:ed)?|(?:un)?likely)\s+(?:for|to|toward|towards|into)\s+(?:(?:a|an|the|finish|end|close|come in|turn|make|be|with|at|in)\s+){0,3}(?:loss|lose|profit|profitable|profitably|red|black)\b`,
    String.raw`(?:\b(?:will|won['\u2019]t|would|wouldn['\u2019]t|should(?:n['\u2019]t)?|could(?:n['\u2019]t)?|may|might|is going to|isn['\u2019]t going to|stands? to)|['\u2019]ll)\s+(?:(?:still|likely|probably|also|not|even|easily)\s+){0,2}(?:lose|make (?:a |any |some |good )?(?:profit|money)|(?:turn|show|post|book) (?:a )?(?:profit|loss)|break[- ]even|(?:end(?: up)?|finish|close|come in|land)\s+(?:(?:in|at|with|above|below)\s+(?:\S+\s+){0,3}?(?:loss|profit|margin|red|black|-?\d[\d.]*%)|profitabl[ey])|(?:be|stay|remain) (?:a |an )?(?:profitable|in the (?:red|black)|loss|money-?loser)|come out (?:ahead|behind))\b`,
  ].join("|"),
  "gi"
);

/** A projected or final margin said not to exist yet ("no forecast margin yet") is fine; one stated is a forecast. */
const OUTCOME_MARGIN_WORDS = /\b(?:projected|expected|forecast(?:ed)?|likely|eventual|final)\s+margins?\b/gi;

/** Doubt about how it will finish isn't a claim about it: "too early to say whether it will make a profit". */
const OUTCOME_DOUBT = new RegExp(NEGATING_LEAD_SRC + String.raw`|\b(?:say|tell|know|sure|clear)\s+(?:yet\s+)?if\b`, "i");

/** Words that join two job codes into a range: "MX05 through MX17", "MX05 to MX17", "MX05-MX17". */
const RANGE_JOIN = /^\s*(?:through|thru|to|until|-|\u2013|\u2014)\s*$/i;

/** The summary is written to the owner, so it never talks about them as someone else ("Give the owner the plain numbers"). */
const OWNER_WORDS = /\bthe (?:business )?owner\b(?!['\u2019]s\b|\s+of\b)/i;

/**
 * A job said to have no estimate: "no estimate on file", "without an
 * estimate", "doesn't have a cost estimate", "lacks an estimate". Not "no
 * estimate problems" or "no estimate changes", not "had no estimate last
 * week", and not "its missing estimate has now been entered". The preview of
 * Oct 29, 2026 said "MX05 through MX17 have no estimates on file", and MX06
 * has one (estimate_said_missing). Only checked against a job the same
 * sentence names: a group ("the rest of the jobs") is left to the prompt,
 * since telling which jobs it means takes more than a pattern.
 */
const NO_ESTIMATE_WORDS = new RegExp(
  [
    String.raw`(?<!\bhad\s)\b(?:no|without|missing)\s+(?:(?:a|an|any|cost)\s+)*(?:estimates?|estimated\s+costs?)\b(?!\s+(?:problems?|issues?|overruns?|gaps?|lines?|checks?|changes?|updates?|revisions?)\b|\s+(?:has|have|was|were)\s+(?:now\s+)?been\b)`,
    String.raw`\bestimates?\s+(?:is|are)\s+missing\b|\bestimates?\s+(?:is|are)(?:n['\u2019]t|\s+not)\s+on file\b`,
    String.raw`\b(?:has|have|do|does)(?:n['\u2019]t|\s+not)\s+(?:got\s+|have\s+)?(?:(?:a|an|any|cost)\s+)*estimates?\b`,
    String.raw`\black(?:s|ing)?\s+(?:(?:a|an|any|cost)\s+)*estimates?\b`,
  ].join("|"),
  "gi"
);

/** An open job that loses money if its costs come in at its estimate (SummaryJobFacts.lossIfCostsMatchEstimate). */
const lossIfEstimateHolds = (j: SummaryJobFacts) => j.status === "open" && (j.lossIfCostsMatchEstimate ?? 0) > 0;

/** A phrase a rule found: its words, whether a negation sits just before it, and the rest of its clause either side. */
interface Hit {
  text: string;
  negated: boolean;
  before: string;
  after: string;
}
/** Where a clause ends, for Hit.before and Hit.after. A comma inside a number isn't one. */
const HIT_CLAUSE = /(?<!\d),|,(?!\d)|[;:()]|\.(?!\d)/;
/** Words that make a loss less than said: "unlikely to lose money", "little chance it will lose money". */
const LOSS_DOUBTED = /\b(?:unlikely|hardly|little chance|no chance|nothing)\b/i;
/**
 * A loss said of a job whose cost estimate is above its contract, as it is:
 * in the future or the conditional ("will lose money", "set to lose
 * $10,000", "at a loss"), not denied or doubted, never "already lost money",
 * "is losing money" or "unprofitable" (only a finished job has lost money),
 * and when an amount follows, the amount it loses at the estimate (review,
 * Oct 29).
 */
function lossAsItIs(job: SummaryJobFacts, hit: Hit): boolean {
  if (!lossIfEstimateHolds(job) || hit.negated) return false;
  if (/n['\u2019]t\b|\bnot\b/i.test(hit.text) || LOSS_DOUBTED.test(hit.text) || LOSS_DOUBTED.test(hit.before)) return false;
  if (!/\blose\b|\bloss\b|\bin the red\b|money-?los/i.test(hit.text) || /\b(?:lost|losing|unprofitable)\b/i.test(hit.text)) return false;
  const amount = /^\s*(?:about\s+|around\s+|roughly\s+)?\$([\d,]+(?:\.\d+)?)/.exec(hit.after);
  return !amount || Math.abs(Number(amount[1].replace(/,/g, "")) - job.lossIfCostsMatchEstimate!) <= 1;
}

/** A cost estimate the contractor has, priced rather than worked out from the target margin. */
const hasPricedEstimate = (j: SummaryJobFacts) => (j.estimatedCost ?? 0) > 0 && !j.estimateSetFromTargetMargin;

// Contact details. Nothing in the data the model is given is one, unless a
// QuickBooks name has one in it.
const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const URL_PATTERN =
  /\b(?:https?:\/\/|www\.)[^\s<>"')\]]+|\b[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.(?:com|net|org|io|co|us|biz|info|app|ai|dev)\b(?:\/[^\s<>"')\]]*)?/gi;
const PHONE_PATTERN = /(?:\+?1[\s.-]?)?(?:\(\d{3}\)\s?|\b\d{3}[\s.-])\d{3}[\s.-]\d{4}\b|\b\d{3}[.-]\d{4}\b/g;

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// --- Job names in the text -----------------------------------------------

/** Where a job is named. `job` is null for a name two jobs share: it can't be told which. */
interface NameSpan {
  start: number;
  end: number;
  job: SummaryJobFacts | null;
}

/** One- and two-letter words a job name that short could be mistaken for. */
const SHORT_WORDS = new Set(
  "a an am as at be by do go he hi i if in is it me my no of oh ok on or so to up us we".split(" ")
);

/**
 * A name as a sentence would write it: any spacing, either apostrophe, and
 * never part of a longer word or number. One that starts or ends with a
 * digit doesn't match inside an amount, a date or a longer number.
 */
function namePattern(name: string, flags: string): RegExp {
  const body = name
    .split(/\s+/)
    .map((w) => escapeRegex(w).replace(/['\u2019]/g, "['\u2019]"))
    .join("\\s+");
  const before = /^\d/.test(name) ? "(?<![A-Za-z0-9$.,/-])" : "(?<![A-Za-z0-9])";
  const after = /\d$/.test(name) ? "(?![A-Za-z0-9%]|[.,/-]\\d)" : "(?![A-Za-z0-9])";
  return new RegExp(`${before}${body}${after}`, flags);
}

/**
 * A job's leading code, such as "MX04", "J-102" or "2024-118", which the
 * summary often names it by. A code with letters needs 3 characters; one of
 * numbers alone needs 4, so a count or a short number isn't taken for one,
 * and can't be a bare year ("2025 Warranty Work" isn't named by "open since
 * 2025"). A numbered code such as "2024-07" still is.
 */
function leadingCode(name: string): string | null {
  const words = name.split(/\s+/);
  if (words.length < 2) return null;
  const code = words[0].replace(/[:,;.]+$/, "");
  if (!/\d/.test(code)) return null;
  if (/[A-Za-z]/.test(code)) return code.length >= 3 ? code : null;
  if (/^(?:19|20)\d\d$/.test(code)) return null;
  return code.length >= 4 && /^#?\d[\d./-]*\d$/.test(code) ? code : null;
}

/**
 * Finds where jobs are named: by full name, case-insensitive, and by a
 * leading code that no other job starts with. Where two overlap, the
 * longest wins ("Harborview Unit 3 Kitchen" over "Harborview" inside it).
 * Names under 3 characters are matched only as written, and not at all
 * when they are also a common word ("A", "Go").
 */
function nameFinder(jobs: SummaryJobFacts[]): (text: string) => NameSpan[] {
  const byName = new Map<string, { name: string; jobs: SummaryJobFacts[] }>();
  for (const job of jobs) {
    const name = job.jobName.trim().replace(/\s+/g, " ");
    if (!name) continue;
    const key = name.toLowerCase();
    const entry = byName.get(key) ?? { name, jobs: [] };
    entry.jobs.push(job);
    byName.set(key, entry);
  }
  const codes = new Map<string, { code: string; jobs: SummaryJobFacts[] }>();
  for (const { name, jobs: same } of byName.values()) {
    const code = leadingCode(name);
    if (!code) continue;
    const entry = codes.get(code.toLowerCase()) ?? { code, jobs: [] };
    entry.jobs.push(...same);
    codes.set(code.toLowerCase(), entry);
  }

  const patterns: { re: RegExp; job: SummaryJobFacts | null }[] = [];
  for (const [key, { name, jobs: same }] of byName) {
    const job = same.length === 1 ? same[0] : null;
    if (name.length >= 3) patterns.push({ re: namePattern(name, "gi"), job });
    else if (!SHORT_WORDS.has(key)) patterns.push({ re: namePattern(name, "g"), job });
  }
  for (const [key, { code, jobs: same }] of codes) {
    // Only a code that one job starts with and that isn't another job's whole name.
    if (same.length === 1 && !byName.has(key)) patterns.push({ re: namePattern(code, "gi"), job: same[0] });
  }

  return (text) => {
    const found: NameSpan[] = [];
    for (const { re, job } of patterns) {
      re.lastIndex = 0;
      for (let m = re.exec(text); m; m = re.exec(text)) found.push({ start: m.index, end: m.index + m[0].length, job });
    }
    found.sort((a, b) => b.end - b.start - (a.end - a.start) || a.start - b.start);
    const kept: NameSpan[] = [];
    for (const m of found) if (!kept.some((k) => m.start < k.end && k.start < m.end)) kept.push(m);
    return kept.sort((a, b) => a.start - b.start);
  };
}

// --- Sentences and clauses -------------------------------------------------

interface Sentence {
  text: string;
  /** Where each job is named, as offsets into `text`. */
  names: NameSpan[];
}

/** Words a full stop doesn't end a sentence after: "1418 Elm St. Remodel", "Smith Inc.", "approx. $3,000". */
const ABBREVIATION = /(?:^|[^A-Za-z0-9])(?:St|Ave|Rd|Dr|Blvd|Ln|Ct|Inc|Co|Corp|LLC|Ltd|Mr|Mrs|Ms|Jr|Sr|vs|approx)\.$/i;
/** An initial: "J. Smith Bath". */
const INITIAL = /(?:^|[^A-Za-z0-9])[A-Z]\.$/;
/** "No. 5 Kitchen": only before a number, so "No. It isn't." still ends a sentence. */
const NUMBER_SIGN = /(?:^|[^A-Za-z0-9])No\.$/i;
const SENTENCE_GAP = /(?<=[.!?])\s+(?=["'(]?[A-Z0-9$])/g;
/** Words that open a sentence, never a name: after "Elm St." or "Building C." they start the next one. */
const OPENS_SENTENCE =
  /^["'(]?(?:The|A|An|It|Its|It['\u2019]s|This|That|These|Those|They|Their|There|We|Our|You|Your|He|She|His|Her|In|On|At|For|By|With|After|Before|Since|But|And|So|Also|Still|However|Meanwhile|Overall|Both|Each|All|Every|Most|Some|None|Nothing|One|Two|Three)\b/;

function splitSentences(paragraph: string, names: NameSpan[]): Sentence[] {
  const out: Sentence[] = [];
  const push = (from: number, to: number) => {
    const raw = paragraph.slice(from, to);
    const text = raw.trim();
    if (!text) return;
    const start = from + (raw.length - raw.trimStart().length);
    const end = start + text.length;
    out.push({
      text,
      names: names.filter((n) => n.start >= start && n.end <= end).map((n) => ({ ...n, start: n.start - start, end: n.end - start })),
    });
  };
  let from = 0;
  SENTENCE_GAP.lastIndex = 0;
  for (let m = SENTENCE_GAP.exec(paragraph); m; m = SENTENCE_GAP.exec(paragraph)) {
    const at = m.index;
    if (names.some((n) => n.start < at && at < n.end)) continue;
    if (paragraph[at - 1] === ".") {
      const before = paragraph.slice(from, at);
      const next = at + m[0].length;
      if (NUMBER_SIGN.test(before) && /^["'(]?\d/.test(paragraph.slice(next))) continue;
      if (ABBREVIATION.test(before) || INITIAL.test(before)) {
        // Still the end of a sentence when a job's name ends at the full stop
        // ("... on Harborview Building C."), a job's name opens the next one
        // ("... on Elm St. Torres Bath is ..."), or a word that only opens a
        // sentence does ("... Elm St. The ..."). Merged, a false claim in
        // the second passed, or a correct first one went with it.
        const nameEnds = names.some((n) => n.end === at || n.end === at - 1);
        const nameOpens = names.some((n) => n.start >= next && /^["'(]?$/.test(paragraph.slice(next, n.start)));
        if (!nameEnds && !nameOpens && !OPENS_SENTENCE.test(paragraph.slice(next))) continue;
      }
    }
    push(from, at);
    from = at + m[0].length;
  }
  push(from, paragraph.length);
  return out;
}

function readParagraphs(text: string, findNames: (text: string) => NameSpan[]): Sentence[][] {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => splitSentences(p, findNames(p)));
}

/**
 * Paragraphs, each split into sentences. Never splits inside a job's name
 * or after a common abbreviation, so "1418 Elm St. Remodel is forecast..."
 * stays one sentence.
 */
export function summarySentences(text: string, jobs: SummaryJobFacts[] = []): string[][] {
  return readParagraphs(text, nameFinder(jobs)).map((p) => p.map((s) => s.text));
}

/**
 * The sentence with each job's name blanked out, offsets kept. The rules
 * are read from this, so their words are never found inside a name
 * ("Forecast Hills Roof", "the Red Oak Kitchen job").
 */
function withoutNames(s: Sentence): string {
  let out = s.text;
  for (const n of s.names) out = out.slice(0, n.start) + "#".repeat(n.end - n.start) + out.slice(n.end);
  return out;
}

interface Clause {
  start: number;
  end: number;
}

// A comma between digits ("$2,000") is part of the number, not a break. A
// relative word ("which", "who") opens a clause and stays in it.
const CLAUSE_BREAK = /(?<!\d),|,(?!\d)|[;:()]|\s(?:but|while|whereas|although|though|unlike)\s|\s(?=(?:which|who|whose)\s)/gi;
const AND = /\sand\s/gi;
const wordCount = (s: string) => (s.trim() ? s.trim().split(/\s+/).length : 0);

/**
 * A sentence's clauses: split at punctuation, at words that start a clause
 * of their own ("but", "while"), and at an "and" that starts one with a job
 * of its own ("... not yet billed and MX03 is forecast to ..."). Not at an
 * "and" that joins two names ("Ruiz Kitchen and Harborview closed ..."), or
 * one that carries on about the same job ("... and is forecast to ...").
 */
function clausesOf(text: string, names: NameSpan[]): Clause[] {
  const cuts: { at: number; to: number }[] = [];
  CLAUSE_BREAK.lastIndex = 0;
  for (let m = CLAUSE_BREAK.exec(text); m; m = CLAUSE_BREAK.exec(text)) cuts.push({ at: m.index, to: m.index + m[0].length });
  AND.lastIndex = 0;
  for (let m = AND.exec(text); m; m = AND.exec(text)) {
    const at = m.index;
    const after = at + m[0].length;
    const next = names.find((n) => n.start >= after);
    if (!next || wordCount(text.slice(after, next.start)) > 1) continue;
    const clauseStart = Math.max(0, ...cuts.filter((c) => c.to <= at).map((c) => c.to));
    const prev = names.filter((n) => n.end <= at && n.start >= clauseStart).pop();
    if (prev && text.slice(prev.end, at).trim() === "") continue;
    cuts.push({ at, to: after });
  }
  cuts.sort((a, b) => a.at - b.at);
  const out: Clause[] = [];
  let start = 0;
  for (const c of cuts) {
    if (c.at > start) out.push({ start, end: c.at });
    start = Math.max(start, c.to);
  }
  if (start < text.length) out.push({ start, end: text.length });
  return out;
}

/** The jobs a phrase is about; "unclear" when it can't be told which. */
type Tie = SummaryJobFacts[] | "unclear" | null;

/**
 * The job or jobs a clause is about: the one it names; the one a phrase is
 * said of ("the forecast for MX03 ..."); else, with several named, its
 * subject (a name that opens it, with the phrase after), or each job in a
 * subject like "Ruiz Kitchen and Harborview". Otherwise "unclear". Null when
 * it names no job.
 */
function clauseJobs(text: string, clause: Clause, names: NameSpan[], phrase?: Clause): Tie {
  const inside = names.filter((n) => n.start >= clause.start && n.end <= clause.end);
  if (inside.length === 0) return null;
  const known = (spans: NameSpan[]): Tie => {
    if (spans.some((n) => n.job == null)) return "unclear";
    return Array.from(new Set(spans.map((n) => n.job as SummaryJobFacts)));
  };
  if (phrase) {
    const next = inside.find((n) => n.start >= phrase.end);
    if (next && /^(?:for|on|of|at)(?:\s+the)?$/i.test(text.slice(phrase.end, next.start).trim())) return known([next]);
  }
  const all = known(inside);
  if (all === "unclear" || all == null || all.length === 1) return all;
  const first = inside[0];
  if (wordCount(text.slice(clause.start, first.start)) > 2) return "unclear";
  if (phrase && phrase.start < first.end) return "unclear";
  const subject = [first];
  for (let i = 1; i < inside.length; i++) {
    const gap = text.slice(inside[i - 1].end, inside[i].start).trim().toLowerCase();
    if (!/^(?:and|&|or|and also|as well as)$/.test(gap) || (phrase && phrase.start < inside[i].end)) break;
    subject.push(inside[i]);
  }
  return known(subject);
}

/**
 * The jobs a phrase is about: decided in its own clause. When that names
 * no job: a clause that opens with "which", "who" or "whose" is about the
 * job named last before it ("Smith Kitchen is ahead of Torres Bath, which
 * is forecast ..." is about Torres Bath), or each job in a subject like
 * "Ruiz Kitchen and Harborview" when that's the last thing named. Any other
 * ("..., and it's forecast ...") is about the subject of the nearest clause
 * before it that names a job ("Smith Kitchen has spent more than Torres
 * Bath, and it's forecast ..." is about Smith Kitchen). Then the first
 * clause after it that names one ("Forecasting 15%, Torres Bath ..."), then
 * what the paragraph was last about ("MX02 is the one to watch. It's
 * forecast to ...").
 */
function phraseJobs(text: string, clauses: Clause[], names: NameSpan[], phrase: Clause, paragraphSubject: Tie): Tie {
  let i = clauses.findIndex((c) => phrase.start >= c.start && phrase.start < c.end);
  if (i < 0) i = clauses.filter((c) => c.start <= phrase.start).length - 1;
  if (i >= 0) {
    const own = clauseJobs(text, clauses[i], names, phrase);
    if (own) return own;
  }
  const before = names.filter((n) => n.end <= phrase.start);
  const relative = i >= 0 && /^\s*(?:which|who|whose)\b/i.test(text.slice(clauses[i].start, clauses[i].end));
  if (relative && before.length) {
    const nearest = before[before.length - 1];
    if (nearest.job == null) return "unclear";
    const home = clauses.find((c) => nearest.start >= c.start && nearest.end <= c.end);
    const tie = home ? clauseJobs(text, home, names) : null;
    if (Array.isArray(tie) && tie.length > 1 && tie.includes(nearest.job)) return tie;
    return [nearest.job];
  }
  for (let k = i - 1; k >= 0; k--) {
    const tie = clauseJobs(text, clauses[k], names);
    if (tie) return tie;
  }
  for (let k = i + 1; k < clauses.length; k++) {
    const tie = clauseJobs(text, clauses[k], names);
    if (tie) return tie;
  }
  return paragraphSubject;
}

/** What a sentence is about, for the sentences after it: its first clause that names a job. */
function sentenceSubject(text: string, clauses: Clause[], names: NameSpan[]): Tie {
  for (const c of clauses) {
    const tie = clauseJobs(text, c, names);
    if (tie) return tie;
  }
  return null;
}

/**
 * Where a negation stops reaching: punctuation, and a word that starts a
 * statement of its own ("has no invoices yet and is losing money"). Not the
 * "yet" of "not yet" or "isn't yet", which is part of the negation, nor of
 * "no evidence yet that" (NEGATING_LEAD).
 */
const NEGATION_STOP = /(?<!\d),|,(?!\d)|[;:()]|\b(?:and|but|or|so|while)\b|(?<!\b(?:not|never)\s+|n['\u2019]t\s+)\byet\b(?!\s+that\b)/i;
/** How many words before a phrase a negation can sit and still be about it ("no firm forecast", "didn't lose money"). */
const NEGATION_REACH = 3;
const ARTICLE = /^(?:a|an|the)$/i;
const NEGATION_ALL = new RegExp(NEGATION.source, "gi");
/**
 * Words that put the rest of their clause in doubt, however far it runs:
 * "There's no sign that X is losing money", "X isn't far enough along to
 * forecast", "We can't tell whether X is losing money". Too far from the
 * phrase for NEGATION_REACH, they made true sentences read as false ones
 * (review of audit Oct 27). Not "whether" after "regardless of",
 * "irrespective of", "no matter" or "no longer", which assert what follows
 * ("The question is no longer whether X is losing money"), and see
 * DOUBT_UNDONE.
 */
const NEGATING_LEAD = new RegExp(NEGATING_LEAD_SRC, "i");
/**
 * After the doubt, a phrase that makes the claim anyway: "no sign that X
 * will stop losing money", "isn't far enough along to stop losing money"
 * both say it is losing money (second review of audit Oct 27). Only right
 * before the claim: "whether the crew will stop work before X is losing
 * money" is still doubt (third review).
 */
const DOUBT_UNDONE = /\b(?:will|to) stop\s*$/i;
/**
 * A negating word that doesn't negate what follows, so the claim after it
 * is still made: "can't avoid losing money", "is no doubt losing money",
 * "won't stop losing money". These passed the check before and after the
 * audit's fix (review of audit Oct 27).
 */
const NOT_A_NEGATION = /\b(?:can['\u2019]?t|cannot|can not) avoid\b|\bno doubt\b|\b(?:won['\u2019]t|doesn['\u2019]t|didn['\u2019]t|don['\u2019]t|never) stop(?:s|ped)?\b/gi;

/**
 * Whether a negating word sits just before position `at`: within
 * NEGATION_REACH words (not counting a, an and the), with no clause break or
 * "and", "but", "or", "so", "yet" or "while" between. It used to be anything
 * in the 30 characters before, through "and" and "but", so "Harbor Deck has
 * no invoices yet and is losing money" passed the check (audit Oct 27, E3).
 * Also when the clause opens with words that put it in doubt
 * (NEGATING_LEAD), and not for an idiom whose negating word doesn't negate
 * (NOT_A_NEGATION).
 */
function negatedBefore(sentence: string, at: number): boolean {
  const before = sentence.slice(Math.max(0, at - 80), at).split(NEGATION_STOP).pop() ?? "";
  const lead = NEGATING_LEAD.exec(before);
  if (lead && !DOUBT_UNDONE.test(before.slice(lead.index))) return true;
  // Each word of an idiom kept as a word, so the count of words is the same.
  const clause = before.replace(NOT_A_NEGATION, (m) => m.replace(/\S+/g, "x"));
  const words = clause.split(/\s+/).filter((w) => w && !ARTICLE.test(w));
  // One word more than the reach, so a two-word negation ("too early") counts when it ends inside it.
  const near = words.slice(-(NEGATION_REACH + 1));
  const reachFrom = near.length > NEGATION_REACH ? near[0].length + 1 : 0;
  const text = near.join(" ");
  for (const m of text.matchAll(NEGATION_ALL)) if (m.index + m[0].length > reachFrom) return true;
  return false;
}

/**
 * Whether the clause before position `at` puts what follows in doubt (OUTCOME_DOUBT):
 * "too early to say whether it will make a profit" makes no claim. For the rule
 * where a plain "not" doesn't excuse the claim (OUTCOME_WORDS).
 */
function doubtedBefore(sentence: string, at: number): boolean {
  const before = sentence.slice(Math.max(0, at - 80), at).split(/(?<!\d),|,(?!\d)|[;:()]|\b(?:and|but|so|while)\b/i).pop() ?? "";
  const lead = OUTCOME_DOUBT.exec(before);
  return lead != null && !DOUBT_UNDONE.test(before.slice(lead.index));
}

/** Links, email addresses and phone numbers in a piece of text, written the same way for comparing. */
function contactDetails(text: string): string[] {
  const found: string[] = [];
  for (const m of text.matchAll(EMAIL_PATTERN)) found.push(m[0].toLowerCase());
  for (const m of text.replace(EMAIL_PATTERN, " ").matchAll(URL_PATTERN)) found.push(m[0].toLowerCase().replace(/[.,;:!?]+$/, ""));
  for (const m of text.matchAll(PHONE_PATTERN)) found.push(m[0].replace(/\D/g, "").replace(/^1(?=\d{10}$)/, ""));
  return found;
}

/**
 * A test for the contact details in a piece of text that aren't in `input`
 * (what the model was given): made up, or planted in a QuickBooks name to
 * steer the model. A link or address is allowed when it's anywhere in the
 * input as written.
 */
function contactsNotIn(input: string): (text: string) => string[] {
  const known = new Set(contactDetails(input));
  const inputLower = input.toLowerCase();
  return (text) => contactDetails(text).filter((d) => !known.has(d) && !(/\D/.test(d) && inputLower.includes(d)));
}

/**
 * The text without any sentence that has a link, email address or phone
 * number that isn't in `input`, the same check the brief's summary gets
 * (contact_not_in_data in findSummaryProblems). For AI-written text that
 * isn't a summary of jobs, such as the Profit Insight cards. Text with none
 * comes back unchanged. Pure.
 */
export function withoutUnknownContacts(text: string, input: string): string {
  const unknown = contactsNotIn(input);
  const bad = summarySentences(text).flat().filter((s) => unknown(s).length > 0);
  return bad.length ? withoutSentences(text, bad) : text;
}

const isOpen = (j: SummaryJobFacts) => j.status === "open";

/** A job code's letters and number: "MX05" is "mx" and 5, "2024-118" is "2024-" and 118. */
function codeParts(name: string): { prefix: string; num: number } | null {
  const code = leadingCode(name.trim().replace(/\s+/g, " "));
  const m = code ? /^(.*?)(\d+)$/.exec(code) : null;
  return m ? { prefix: m[1].toLowerCase(), num: Number(m[2]) } : null;
}

/**
 * A range of job codes in the sentence that takes in jobs it doesn't name:
 * "MX05 through MX17" takes in MX06 to MX16. The preview of Oct 29, 2026
 * said "MX05 through MX17 have no estimates on file", and MX06 has one.
 * Null when the sentence has no such range.
 */
function rangeOfJobs(s: Sentence, jobs: SummaryJobFacts[]): { from: string; to: string; inside: SummaryJobFacts[] } | null {
  for (let i = 1; i < s.names.length; i++) {
    const a = s.names[i - 1];
    const b = s.names[i];
    if (!a.job || !b.job || !RANGE_JOIN.test(s.text.slice(a.end, b.start))) continue;
    const pa = codeParts(a.job.jobName);
    const pb = codeParts(b.job.jobName);
    if (!pa || !pb || pa.prefix !== pb.prefix) continue;
    // "from MX05 Overdue Invoice to MX07 Parent Match" is two jobs, not a range: "to" joins one only between bare codes.
    const bare = (n: NameSpan) => leadingCode(n.job!.jobName.trim().replace(/\s+/g, " "))?.toLowerCase() === s.text.slice(n.start, n.end).toLowerCase();
    if (/^\s*(?:to|until)\s*$/i.test(s.text.slice(a.end, b.start)) && !(bare(a) && bare(b))) continue;
    const lo = Math.min(pa.num, pb.num);
    const hi = Math.max(pa.num, pb.num);
    const inside = jobs.filter((j) => {
      const p = codeParts(j.jobName);
      return p != null && p.prefix === pa.prefix && p.num > lo && p.num < hi;
    });
    if (inside.length) return { from: s.text.slice(a.start, a.end), to: s.text.slice(b.start, b.end), inside };
  }
  return null;
}

/**
 * The sentences in an AI-written summary that break the brief's rules, in
 * the cases that have actually gone wrong: a forecast for a job that has
 * none firm enough to state, a loss on a job that hasn't made one, an open
 * job called under budget, an overrun on an estimate the contractor never
 * priced, talk of the week-over-week comparison when there wasn't one
 * ("Nothing changed since the last brief" in a week nothing was compared),
 * a link, email address or phone number that isn't in the data, and since
 * the preview of Oct 29, 2026: how an open job without a forecast will
 * finish, said either way; a range of jobs that takes in ones it doesn't
 * name; "the owner" in a summary written to them; and "no estimate" said of
 * a job that has one.
 *
 * Job names are found first, and the rules are read only outside them. A
 * phrase is tied to a job only when it's clear which (see phraseJobs); when
 * it isn't, the job rules are skipped for it rather than pinned on the
 * wrong job. Pure.
 */
export function findSummaryProblems(text: string, facts: SummaryFacts): SummaryProblem[] {
  const problems: SummaryProblem[] = [];
  const unknownContacts = contactsNotIn(facts.input ?? "");
  for (const paragraph of readParagraphs(text, nameFinder(facts.jobs))) {
    let paragraphSubject: Tie = null;
    for (const s of paragraph) {
      const plain = withoutNames(s);
      const clauses = clausesOf(plain, s.names);
      const found = new Set<SummaryRule>();
      const add = (p: SummaryProblem) => {
        if (found.has(p.rule)) return;
        found.add(p.rule);
        problems.push(p);
      };
      // `negationCounts`: the claim is wrong said either way (OUTCOME_WORDS),
      // so a "not" before it doesn't make it right.
      const scan = (
        re: RegExp,
        check: (job: SummaryJobFacts, hit: Hit) => Omit<SummaryProblem, "sentence" | "jobName"> | null,
        negationCounts = false
      ) => {
        re.lastIndex = 0;
        for (let m = re.exec(plain); m; m = re.exec(plain)) {
          const negated = negatedBefore(plain, m.index);
          if (negationCounts ? doubtedBefore(plain, m.index) : negated) continue;
          const tie = phraseJobs(plain, clauses, s.names, { start: m.index, end: m.index + m[0].length }, paragraphSubject);
          if (!Array.isArray(tie)) continue;
          for (const job of tie) {
            const end = m.index + m[0].length;
            const problem = check(job, {
              text: m[0],
              negated,
              before: plain.slice(0, m.index).split(HIT_CLAUSE).pop() ?? "",
              after: plain.slice(end).split(HIT_CLAUSE)[0] ?? "",
            });
            if (problem) {
              add({ ...problem, sentence: s.text, jobName: job.jobName });
              break;
            }
          }
        }
      };

      scan(FORECAST_WORDS, (job) => {
        if (isOpen(job) && job.forecastMarginPct != null) return null;
        return {
          rule: "forecast_without_forecast",
          reason: isOpen(job)
            ? lossIfEstimateHolds(job)
              ? `${job.jobName} has no forecastMarginPct, so don't call anything about it a forecast. Say instead that its cost estimate is above its contract, so it loses ${formatCurrency(job.lossIfCostsMatchEstimate!)} if costs come in at the estimate.`
              : `${job.jobName} has no forecastMarginPct, so nothing about it may be called a forecast or what it is "on track" for. Give its spend against the estimate and what has been billed.`
            : `${job.jobName} is finished, so it has no forecast. Give how it closed.`,
        };
      });
      scan(LOSS_WORDS, (job, hit) => {
        const loss = isOpen(job)
          ? (job.forecastMarginPct != null && job.forecastMarginPct < 0) || lossAsItIs(job, hit)
          : job.marginPct != null && job.marginPct < 0;
        if (loss) return null;
        return {
          rule: "loss_without_loss",
          reason: isOpen(job)
            ? `${job.jobName} is still open and has no forecast below zero, so it isn't losing money. Give what has been spent and what has been billed.`
            : `${job.jobName} closed with revenue above its cost, so it didn't lose money.`,
        };
      });
      scan(UNDER_BUDGET_WORDS, (job) =>
        isOpen(job)
          ? {
              rule: "open_job_under_budget",
              reason: `${job.jobName} is still open, so it can't be under budget. Give its spend so far against the estimate.`,
            }
          : null
      );
      scan(OVERRUN_WORDS, (job) =>
        job.estimateSetFromTargetMargin
          ? {
              rule: "target_estimate_overrun",
              reason: `${job.jobName}'s estimate was worked out from the target margin, not priced, so never say it went over its estimate. Say it cost more than the target margin allows.`,
            }
          : null
      );

      // A sentence already sent back for calling it a forecast or a loss
      // needs no third reason for the same words.
      const outcomeCovered = (job: SummaryJobFacts) =>
        problems.some((p) => p.sentence === s.text && p.jobName === job.jobName && (p.rule === "forecast_without_forecast" || p.rule === "loss_without_loss"));
      const outcomeProblem = (job: SummaryJobFacts) => ({
        rule: "outcome_without_forecast" as const,
        reason: lossIfEstimateHolds(job)
          ? `${job.jobName} has no forecastMarginPct, but its cost estimate is above its contract: say it loses ${formatCurrency(job.lossIfCostsMatchEstimate!)} if costs come in at the estimate, and never that it will do better than that.`
          : `${job.jobName} is open and has no forecastMarginPct, so say nothing about how it will finish, either way: not that it is heading for a loss or a profit, and not that it isn't. Give its spend against the estimate and what has been billed.`,
      });
      const noForecast = (job: SummaryJobFacts) => isOpen(job) && job.forecastMarginPct == null && !outcomeCovered(job);
      // A loss said as it is of a job whose estimate is above its contract
      // is true without a forecast (lossAsItIs).
      scan(OUTCOME_WORDS, (job, hit) => (noForecast(job) && !lossAsItIs(job, hit) ? outcomeProblem(job) : null), true);
      scan(OUTCOME_MARGIN_WORDS, (job) => (noForecast(job) ? outcomeProblem(job) : null));

      const range = rangeOfJobs(s, facts.jobs);
      if (range) {
        const names = range.inside.map((j) => j.jobName);
        const list = names.length > 3 ? `${names.slice(0, 3).join(", ")} and ${names.length - 3} more` : names.join(" and ");
        add({
          rule: "range_of_jobs",
          sentence: s.text,
          reason: `It describes jobs as a range (${range.from} to ${range.to}), which takes in ${list} as well, and what it says may not be true of them. Name each job you mean.`,
        });
      }

      if (OWNER_WORDS.test(plain)) {
        add({
          rule: "owner_in_third_person",
          sentence: s.text,
          reason: 'The summary is written to the owner. Address them as "you" and never write "the owner".',
        });
      }

      // "No estimate" said of a job the sentence names, when it has one.
      scan(NO_ESTIMATE_WORDS, (job) =>
        hasPricedEstimate(job) && s.names.some((n) => n.job === job)
          ? { rule: "estimate_said_missing", reason: `${job.jobName} has a cost estimate, so don't say it has none.` }
          : null
      );

      if (facts.comparison === "skipped") {
        if (COMPARISON_WORDS.test(plain)) {
          add({
            rule: "comparison_skipped",
            sentence: s.text,
            reason:
              "There was no comparison with an earlier brief this week, which is not the same as nothing changing. Leave the comparison out: the section above the summary already explains it.",
          });
        }
      } else if (facts.comparison === "changes" && NOTHING_CHANGED_WORDS.test(plain) && !negatedBefore(plain, plain.search(NOTHING_CHANGED_WORDS))) {
        add({
          rule: "nothing_changed",
          sentence: s.text,
          reason: "weekOverWeek shows changes since the last brief, so don't say nothing changed.",
        });
      }

      if (unknownContacts(s.text).length > 0) {
        add({
          rule: "contact_not_in_data",
          sentence: s.text,
          reason: "It has a link, email address or phone number that isn't in the data. Never put one in the summary.",
        });
      }

      if (s.names.length) paragraphSubject = sentenceSubject(plain, clauses, s.names);
    }
  }
  return problems;
}

/**
 * How a sentence starts when it carries on about the one before it: "It has
 * $34,000 spent...", "By contrast, ...", "The margin number there ...". Not
 * "This week ...".
 */
const REFERS_BACK =
  /^["'(]?(?:it|its|it['\u2019]s|that|that['\u2019]s|this(?!\s+(?:week|month|year|brief|summary)\b)|these|those|they|they['\u2019]re|their|them|the job|this job|that job|the same job|by contrast|in contrast|still|even so|even then|however|but|and|so|also|plus|which|despite (?:that|this)|that said|otherwise|instead|either way|as a result)\b|^(?:\S+\s+){0,4}there\b/i;

/**
 * The text without the given sentences, paragraphs kept; a paragraph left
 * empty goes. A sentence that came straight after one taken out, names no
 * job and refers back to it ("It has $34,000 spent...") goes too, and so on
 * up to the next sentence that names a job: left in, it would read as being
 * about the job before. Text with nothing to remove comes back unchanged.
 * Pass the jobs the summary is about, so its sentences are split the way
 * findSummaryProblems split them.
 */
export function withoutSentences(text: string, remove: Iterable<string>, jobs: SummaryJobFacts[] = []): string {
  const gone = new Set(Array.from(remove, (s) => s.trim()));
  if (gone.size === 0) return text;
  return readParagraphs(text, nameFinder(jobs))
    .map((sentences) => {
      const kept: string[] = [];
      let afterRemoved = false;
      for (const s of sentences) {
        if (gone.has(s.text)) {
          afterRemoved = true;
          continue;
        }
        if (afterRemoved && s.names.length === 0 && REFERS_BACK.test(s.text)) continue;
        afterRemoved = false;
        kept.push(s.text);
      }
      return kept.join(" ");
    })
    .filter(Boolean)
    .join("\n\n");
}
