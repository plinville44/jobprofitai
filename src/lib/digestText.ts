// Deterministic guard rails around the AI-written part of the Weekly Profit
// Brief: what the model is given, and what comes back.
//
// The prompt asks for all of this. This makes it true whether or not the
// model listened, because the text goes straight into a customer's inbox.

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
  | "contact_not_in_data";

export interface SummaryProblem {
  rule: SummaryRule;
  /** The sentence, exactly as it appears in the text. */
  sentence: string;
  jobName?: string;
  /** What's wrong, in words the model is given when asked to rewrite. */
  reason: string;
}

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
 * and can't look like a year or a month ("2025 Warranty Work" isn't named
 * by "open since 2025").
 */
function leadingCode(name: string): string | null {
  const words = name.split(/\s+/);
  if (words.length < 2) return null;
  const code = words[0].replace(/[:,;.]+$/, "");
  if (!/\d/.test(code)) return null;
  if (/[A-Za-z]/.test(code)) return code.length >= 3 ? code : null;
  if (/^(?:19|20)\d\d(?:[-/.](?:0?[1-9]|1[0-2]))?$/.test(code)) return null;
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
 * The jobs a phrase is about: decided in its own clause; when that names
 * no job ("it's forecasting ...", "which is forecast ..."), the job named
 * last before it in the sentence ("Smith Kitchen is ahead of Torres Bath,
 * which is forecast ..." is about Torres Bath), or each job in a subject
 * like "Ruiz Kitchen and Harborview" when that's the last thing named; then
 * the first clause after it that names one ("Forecasting 15%, Torres Bath
 * ..."); then what the paragraph was last about ("MX02 is the one to watch.
 * It's forecast to ...").
 */
function phraseJobs(text: string, clauses: Clause[], names: NameSpan[], phrase: Clause, paragraphSubject: Tie): Tie {
  let i = clauses.findIndex((c) => phrase.start >= c.start && phrase.start < c.end);
  if (i < 0) i = clauses.filter((c) => c.start <= phrase.start).length - 1;
  if (i >= 0) {
    const own = clauseJobs(text, clauses[i], names, phrase);
    if (own) return own;
  }
  const before = names.filter((n) => n.end <= phrase.start);
  if (before.length) {
    const nearest = before[before.length - 1];
    if (nearest.job == null) return "unclear";
    const home = clauses.find((c) => nearest.start >= c.start && nearest.end <= c.end);
    const tie = home ? clauseJobs(text, home, names) : null;
    if (Array.isArray(tie) && tie.length > 1 && tie.includes(nearest.job)) return tie;
    return [nearest.job];
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

/** Whether a negating word sits in the same clause just before position `at`. */
function negatedBefore(sentence: string, at: number): boolean {
  const before = sentence.slice(Math.max(0, at - 30), at);
  const clause = before.split(/(?<!\d),|,(?!\d)|[;:]/).pop() ?? "";
  return NEGATION.test(clause);
}

/** Links, email addresses and phone numbers in a piece of text, written the same way for comparing. */
function contactDetails(text: string): string[] {
  const found: string[] = [];
  for (const m of text.matchAll(EMAIL_PATTERN)) found.push(m[0].toLowerCase());
  for (const m of text.replace(EMAIL_PATTERN, " ").matchAll(URL_PATTERN)) found.push(m[0].toLowerCase().replace(/[.,;:!?]+$/, ""));
  for (const m of text.matchAll(PHONE_PATTERN)) found.push(m[0].replace(/\D/g, "").replace(/^1(?=\d{10}$)/, ""));
  return found;
}

const isOpen = (j: SummaryJobFacts) => j.status === "open";

/**
 * The sentences in an AI-written summary that break the brief's rules, in
 * the cases that have actually gone wrong: a forecast for a job that has
 * none firm enough to state, a loss on a job that hasn't made one, an open
 * job called under budget, an overrun on an estimate the contractor never
 * priced, talk of the week-over-week comparison when there wasn't one
 * ("Nothing changed since the last brief" in a week nothing was compared),
 * and a link, email address or phone number that isn't in the data.
 *
 * Job names are found first, and the rules are read only outside them. A
 * phrase is tied to a job only when it's clear which (see phraseJobs); when
 * it isn't, the job rules are skipped for it rather than pinned on the
 * wrong job. Pure.
 */
export function findSummaryProblems(text: string, facts: SummaryFacts): SummaryProblem[] {
  const problems: SummaryProblem[] = [];
  const input = facts.input ?? "";
  const inputLower = input.toLowerCase();
  const knownContacts = new Set(contactDetails(input));
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
      const scan = (re: RegExp, check: (job: SummaryJobFacts) => Omit<SummaryProblem, "sentence" | "jobName"> | null) => {
        re.lastIndex = 0;
        for (let m = re.exec(plain); m; m = re.exec(plain)) {
          if (negatedBefore(plain, m.index)) continue;
          const tie = phraseJobs(plain, clauses, s.names, { start: m.index, end: m.index + m[0].length }, paragraphSubject);
          if (!Array.isArray(tie)) continue;
          for (const job of tie) {
            const problem = check(job);
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
            ? `${job.jobName} has no forecastMarginPct, so nothing about it may be called a forecast or what it is "on track" for. Give its spend against the estimate and what has been billed.`
            : `${job.jobName} is finished, so it has no forecast. Give how it closed.`,
        };
      });
      scan(LOSS_WORDS, (job) => {
        const loss = isOpen(job) ? job.forecastMarginPct != null && job.forecastMarginPct < 0 : job.marginPct != null && job.marginPct < 0;
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

      const unknown = contactDetails(s.text).filter((d) => !knownContacts.has(d) && !(/\D/.test(d) && inputLower.includes(d)));
      if (unknown.length > 0) {
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
