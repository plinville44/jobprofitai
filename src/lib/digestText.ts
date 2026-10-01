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
}

export type SummaryRule =
  | "forecast_without_forecast"
  | "loss_without_loss"
  | "open_job_under_budget"
  | "target_estimate_overrun"
  | "comparison_skipped"
  | "nothing_changed";

export interface SummaryProblem {
  rule: SummaryRule;
  /** The sentence, exactly as it appears in the text. */
  sentence: string;
  jobName?: string;
  /** What's wrong, in words the model is given when asked to rewrite. */
  reason: string;
}

/** A word that turns the phrase after it around: "no forecast", "didn't lose money". */
const NEGATION = /\b(no|not|none|never|without|too early|cannot)\b|n't\b/i;

const FORECAST_WORDS =
  /\b(forecast(?:s|ing|ed)?|on track (?:to|for)|heading (?:for|toward|towards)|projected to|expected to (?:finish|close|end|land|come in))\b/gi;
const LOSS_WORDS = /\b(los(?:ing|es|t) money|lose money|money-losing|at a loss|in the red|unprofitable)\b/gi;
const UNDER_BUDGET_WORDS = /\b(under (?:its |the |their )?(?:\$[\d,.]+ )?(?:budget|estimates?)|came in under)\b/gi;
const OVERRUN_WORDS =
  /\b(over (?:its |the |their )?(?:\$[\d,.]+ )?(?:estimate|budget)|overr(?:an|un|uns|unning)|ran over|went over|gone over|exceeded (?:its |the |their )?(?:estimate|budget))\b/gi;
const COMPARISON_WORDS =
  /\b(nothing (?:has )?changed|no changes|nothing new|(?:can't|cannot|couldn't|can not) be compared|(?:wasn't|weren't|isn't|aren't|not) compared|comparison|baseline|compared (?:to|with|against) last week)\b/i;
const NOTHING_CHANGED_WORDS = /\b(nothing (?:has )?changed|no changes|nothing new)\b/i;

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Paragraphs, each split into sentences. */
export function summarySentences(text: string): string[][] {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) =>
      p
        .split(/(?<=[.!?])\s+(?=["'(]?[A-Z0-9$])/)
        .map((s) => s.trim())
        .filter(Boolean)
    );
}

interface Mention {
  start: number;
  end: number;
  job: SummaryJobFacts;
}

/**
 * Where each job is named in a sentence. A job is matched by its full name,
 * and by a leading code such as "MX04" or "J-102" when no other job starts
 * with it. The longest name wins where two overlap ("Harborview" inside
 * "Harborview Unit 3 Kitchen").
 */
function mentionFinder(jobs: SummaryJobFacts[]) {
  const codeCount = new Map<string, number>();
  const codeOf = (name: string) => {
    const first = name.trim().split(/\s+/)[0] ?? "";
    return first.length >= 3 && /[A-Za-z]/.test(first) && /\d/.test(first) && name.trim().includes(" ") ? first.toLowerCase() : null;
  };
  for (const j of jobs) {
    const code = codeOf(j.jobName);
    if (code) codeCount.set(code, (codeCount.get(code) ?? 0) + 1);
  }
  const patterns: { re: RegExp; job: SummaryJobFacts }[] = [];
  for (const j of jobs) {
    const names = [j.jobName.trim()];
    const code = codeOf(j.jobName);
    if (code && codeCount.get(code) === 1) names.push(code);
    for (const n of names) {
      if (n.length < 3) continue;
      patterns.push({ re: new RegExp(`(?<![A-Za-z0-9])${escapeRegex(n)}(?![A-Za-z0-9])`, "gi"), job: j });
    }
  }
  return (sentence: string): Mention[] => {
    const found: Mention[] = [];
    for (const { re, job } of patterns) {
      re.lastIndex = 0;
      for (let m = re.exec(sentence); m; m = re.exec(sentence)) found.push({ start: m.index, end: m.index + m[0].length, job });
    }
    found.sort((a, b) => a.start - b.start || b.end - a.end);
    const kept: Mention[] = [];
    for (const m of found) {
      if (kept.some((k) => m.start >= k.start && m.end <= k.end)) continue;
      kept.push(m);
    }
    return kept;
  };
}

/** Whether a negating word sits in the same clause just before position `at`. */
function negatedBefore(sentence: string, at: number): boolean {
  const before = sentence.slice(Math.max(0, at - 30), at);
  const clause = before.split(/[,;:]/).pop() ?? "";
  return NEGATION.test(clause);
}

const isOpen = (j: SummaryJobFacts) => j.status === "open";

/**
 * The sentences in an AI-written summary that break the brief's rules, in
 * the cases that have actually gone wrong: a forecast for a job that has
 * none firm enough to state, a loss on a job that hasn't made one, an open
 * job called under budget, an overrun on an estimate the contractor never
 * priced, and talk of the week-over-week comparison when there wasn't one
 * ("Nothing changed since the last brief" in a week nothing was compared).
 *
 * A phrase is about the job named nearest before it in the sentence, else
 * the first job named after it, else the last job named earlier in the
 * paragraph ("MX02 is the one to look at. It's forecast to finish at..."),
 * else no job, and the job rules are skipped. Pure.
 */
export function findSummaryProblems(text: string, facts: SummaryFacts): SummaryProblem[] {
  const problems: SummaryProblem[] = [];
  const mentionsIn = mentionFinder(facts.jobs);
  for (const paragraph of summarySentences(text)) {
    let lastJob: SummaryJobFacts | null = null;
    for (const sentence of paragraph) {
      const mentions = mentionsIn(sentence);
      const subjectAt = (at: number): SummaryJobFacts | null => {
        const before = mentions.filter((m) => m.end <= at);
        if (before.length) return before[before.length - 1].job;
        const after = mentions.find((m) => m.start >= at);
        return after?.job ?? lastJob;
      };
      const found = new Set<SummaryRule>();
      const add = (p: SummaryProblem) => {
        if (found.has(p.rule)) return;
        found.add(p.rule);
        problems.push(p);
      };
      const scan = (re: RegExp, check: (job: SummaryJobFacts) => Omit<SummaryProblem, "sentence" | "jobName"> | null) => {
        re.lastIndex = 0;
        for (let m = re.exec(sentence); m; m = re.exec(sentence)) {
          if (negatedBefore(sentence, m.index)) continue;
          const job = subjectAt(m.index);
          if (!job) continue;
          const problem = check(job);
          if (problem) add({ ...problem, sentence, jobName: job.jobName });
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
        const m = COMPARISON_WORDS.exec(sentence);
        if (m && !/\b(?:by|in) comparison\b/i.test(sentence)) {
          add({
            rule: "comparison_skipped",
            sentence,
            reason:
              "There was no comparison with an earlier brief this week, which is not the same as nothing changing. Leave the comparison out: the section above the summary already explains it.",
          });
        }
      } else if (facts.comparison === "changes" && NOTHING_CHANGED_WORDS.test(sentence) && !negatedBefore(sentence, sentence.search(NOTHING_CHANGED_WORDS))) {
        add({
          rule: "nothing_changed",
          sentence,
          reason: "weekOverWeek shows changes since the last brief, so don't say nothing changed.",
        });
      }

      if (mentions.length) lastJob = mentions[mentions.length - 1].job;
    }
  }
  return problems;
}

/**
 * The text without the given sentences, paragraphs kept; a paragraph left
 * empty goes. Text with nothing to remove comes back unchanged.
 */
export function withoutSentences(text: string, remove: Iterable<string>): string {
  const gone = new Set(Array.from(remove, (s) => s.trim()));
  if (gone.size === 0) return text;
  return summarySentences(text)
    .map((p) => p.filter((s) => !gone.has(s)).join(" "))
    .filter(Boolean)
    .join("\n\n");
}
