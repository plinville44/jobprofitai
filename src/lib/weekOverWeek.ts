import type { ConnectionMetrics } from "./profitability";
import { formatCurrency, formatPct, formatShortDate } from "./format";

// Week-over-week changes for the Weekly Profit Brief.
//
// Every brief stores the full job metrics it was written from
// (WeeklyDigest.metrics). This compares the current metrics against the most
// recent earlier snapshot and reports what moved.
//
// Why snapshots and not transaction dates. Filtering bills and invoices to
// "dated in the last seven days" is the obvious approach and it misses most
// of what actually changes in a contractor's books: a bill entered today but
// dated last month, a job marked complete, an estimate typed in, a credit
// memo that reduces billing. Comparing what the books said a week ago with
// what they say now catches all of those, because it doesn't care why a
// number moved, only that it did.
//
// Entirely deterministic. The section this produces is shown to the
// customer verbatim, above the AI-written narrative, so every figure in it
// is arithmetic on stored numbers. The model is told about these changes
// but does not write them.

/** Dollar movements smaller than this are rounding, not activity. */
const MONEY_EPSILON = 0.5;
/** Margin moves smaller than half a point aren't worth a line. */
const MARGIN_EPSILON = 0.005;
/** Matches the over-budget threshold in computeJobFinancials. */
const OVER_BUDGET_PCT = 0.1;
/** Past this many jobs the section stops being skimmable. */
const MAX_JOB_LINES = 8;

export interface JobChange {
  jobId: string;
  jobName: string;
  isNew: boolean;
  removed: boolean;
  statusChange: "completed" | "reopened" | null;
  costAdded: number;
  revenueAdded: number;
  marginBefore: number | null;
  marginAfter: number | null;
  estimateBefore: number | null;
  estimateAfter: number | null;
  /** Set only when the job crossed from within budget to 10%+ over. */
  nowOverBudgetPct: number | null;
}

export interface WeekOverWeekReport {
  /** The week of the snapshot compared against. Null when there is none. */
  comparedToWeekStarting: Date | null;
  /** Why there is no comparison, when there isn't one. */
  noComparisonReason: "first_brief" | "unreadable_snapshot" | null;
  revenueAdded: number;
  costAdded: number;
  marginBefore: number | null;
  marginAfter: number | null;
  /** Most significant first. */
  changes: JobChange[];
  unchangedJobs: number;
}

interface SnapshotJob {
  jobId: string;
  jobName: string;
  status: string | null;
  actualCost: number;
  actualRevenue: number;
  marginPct: number | null;
  estimatedCost: number | null;
  varianceVsEstimatePct: number | null;
}

interface Snapshot {
  jobs: SnapshotJob[];
  totalRevenue: number;
  totalCost: number;
  marginPct: number | null;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * Reads a stored snapshot defensively. It is JSON written by an earlier
 * version of this app, possibly months ago, and a brief must still go out
 * if one field has changed shape since. Anything unreadable returns null
 * and the brief says so, rather than comparing against a half-parsed week.
 */
function readSnapshot(raw: unknown): Snapshot | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.jobs)) return null;

  const jobs: SnapshotJob[] = [];
  for (const j of r.jobs as unknown[]) {
    if (!j || typeof j !== "object") return null;
    const o = j as Record<string, unknown>;
    const actualCost = num(o.actualCost);
    const actualRevenue = num(o.actualRevenue);
    if (typeof o.jobId !== "string" || actualCost == null || actualRevenue == null) return null;
    jobs.push({
      jobId: o.jobId,
      jobName: typeof o.jobName === "string" ? o.jobName : "Unnamed job",
      status: typeof o.status === "string" ? o.status : null,
      actualCost,
      actualRevenue,
      marginPct: num(o.marginPct),
      estimatedCost: num(o.estimatedCost),
      varianceVsEstimatePct: num(o.varianceVsEstimatePct),
    });
  }

  // Totals are recomputed from the jobs rather than trusted from the stored
  // `totals` block, so the company line always agrees with the job lines.
  const totalRevenue = jobs.reduce((s, j) => s + j.actualRevenue, 0);
  const totalCost = jobs.reduce((s, j) => s + j.actualCost, 0);
  // Blended margin over jobs with both revenue and costs only: the same basis
  // as the dashboard's Job Gross Profit, so the brief and the dashboard can't
  // quote two different company margins for the same books.
  const basis = jobs.filter((j) => j.actualRevenue > 0 && j.actualCost > 0);
  const basisRevenue = basis.reduce((s, j) => s + j.actualRevenue, 0);
  const basisCost = basis.reduce((s, j) => s + j.actualCost, 0);
  return {
    jobs,
    totalRevenue,
    totalCost,
    marginPct: basisRevenue > 0 ? (basisRevenue - basisCost) / basisRevenue : null,
  };
}

function snapshotFromCurrent(current: ConnectionMetrics): Snapshot {
  return readSnapshot(current) ?? { jobs: [], totalRevenue: 0, totalCost: 0, marginPct: null };
}

const isOverBudget = (pct: number | null) => pct != null && pct > OVER_BUDGET_PCT;

export function computeWeekOverWeek(
  prior: { weekStarting: Date; metrics: unknown } | null,
  current: ConnectionMetrics
): WeekOverWeekReport {
  const now = snapshotFromCurrent(current);
  const empty = {
    revenueAdded: 0,
    costAdded: 0,
    marginBefore: null,
    marginAfter: now.marginPct,
    changes: [],
    unchangedJobs: 0,
  };

  if (!prior) {
    return { ...empty, comparedToWeekStarting: null, noComparisonReason: "first_brief" };
  }
  const before = readSnapshot(prior.metrics);
  if (!before) {
    return { ...empty, comparedToWeekStarting: null, noComparisonReason: "unreadable_snapshot" };
  }

  const beforeById = new Map(before.jobs.map((j) => [j.jobId, j]));
  const changes: JobChange[] = [];
  let unchangedJobs = 0;

  for (const job of now.jobs) {
    const was = beforeById.get(job.jobId);

    if (!was) {
      changes.push({
        jobId: job.jobId,
        jobName: job.jobName,
        isNew: true,
        removed: false,
        statusChange: null,
        costAdded: job.actualCost,
        revenueAdded: job.actualRevenue,
        marginBefore: null,
        marginAfter: job.marginPct,
        estimateBefore: null,
        estimateAfter: job.estimatedCost,
        nowOverBudgetPct: isOverBudget(job.varianceVsEstimatePct) ? job.varianceVsEstimatePct : null,
      });
      continue;
    }

    const costAdded = job.actualCost - was.actualCost;
    const revenueAdded = job.actualRevenue - was.actualRevenue;
    const statusChange =
      was.status === "open" && job.status === "closed"
        ? "completed"
        : was.status === "closed" && job.status === "open"
          ? "reopened"
          : null;
    const estimateMoved =
      was.estimatedCost !== job.estimatedCost &&
      !(was.estimatedCost != null && job.estimatedCost != null &&
        Math.abs(was.estimatedCost - job.estimatedCost) < MONEY_EPSILON);
    const nowOverBudgetPct =
      !isOverBudget(was.varianceVsEstimatePct) && isOverBudget(job.varianceVsEstimatePct)
        ? job.varianceVsEstimatePct
        : null;

    const moved =
      Math.abs(costAdded) >= MONEY_EPSILON ||
      Math.abs(revenueAdded) >= MONEY_EPSILON ||
      statusChange != null ||
      estimateMoved ||
      nowOverBudgetPct != null;

    if (!moved) {
      unchangedJobs++;
      continue;
    }

    changes.push({
      jobId: job.jobId,
      jobName: job.jobName,
      isNew: false,
      removed: false,
      statusChange,
      costAdded,
      revenueAdded,
      marginBefore: was.marginPct,
      marginAfter: job.marginPct,
      estimateBefore: was.estimatedCost,
      estimateAfter: job.estimatedCost,
      nowOverBudgetPct,
    });
  }

  const nowIds = new Set(now.jobs.map((j) => j.jobId));
  for (const was of before.jobs) {
    if (nowIds.has(was.jobId)) continue;
    changes.push({
      jobId: was.jobId,
      jobName: was.jobName,
      isNew: false,
      removed: true,
      statusChange: null,
      costAdded: 0,
      revenueAdded: 0,
      marginBefore: was.marginPct,
      marginAfter: null,
      estimateBefore: was.estimatedCost,
      estimateAfter: null,
      nowOverBudgetPct: null,
    });
  }

  // Ordering is the editorial judgment in this module, so it is spelled out:
  // a job that just went over budget is the thing an owner can still act
  // on, so it leads. A completed job is a final result. After those, the
  // biggest dollar movement first.
  const rank = (c: JobChange) =>
    (c.nowOverBudgetPct != null ? 2 : 0) + (c.statusChange === "completed" ? 1 : 0);
  changes.sort(
    (a, b) =>
      rank(b) - rank(a) ||
      Math.abs(b.costAdded) + Math.abs(b.revenueAdded) - (Math.abs(a.costAdded) + Math.abs(a.revenueAdded))
  );

  return {
    comparedToWeekStarting: prior.weekStarting,
    noComparisonReason: null,
    revenueAdded: now.totalRevenue - before.totalRevenue,
    costAdded: now.totalCost - before.totalCost,
    marginBefore: before.marginPct,
    marginAfter: now.marginPct,
    changes,
    unchangedJobs,
  };
}

// --- Rendering ----------------------------------------------------------

function billedPhrase(amount: number): string | null {
  if (Math.abs(amount) < MONEY_EPSILON) return null;
  return amount > 0 ? `${formatCurrency(amount)} newly billed` : `billing down ${formatCurrency(-amount)}`;
}

function costPhrase(amount: number): string | null {
  if (Math.abs(amount) < MONEY_EPSILON) return null;
  return amount > 0 ? `${formatCurrency(amount)} in new costs` : `costs down ${formatCurrency(-amount)}`;
}

function marginPhrase(before: number | null, after: number | null): string | null {
  if (after == null) return null;
  if (before == null) return `Margin now ${formatPct(after)}.`;
  if (Math.abs(after - before) < MARGIN_EPSILON) return null;
  return `Margin ${formatPct(before)} to ${formatPct(after)}.`;
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function renderJobLine(c: JobChange): string {
  return `- ${c.jobName}: ${jobChangeSentence(c)}`;
}

/** What happened to one job since the last brief, without the job's name. */
export function jobChangeSentence(c: JobChange): string {
  if (c.removed) return "no longer in your synced jobs.";

  const parts: string[] = [];

  if (c.isNew) {
    const money = [
      Math.abs(c.revenueAdded) >= MONEY_EPSILON ? `${formatCurrency(c.revenueAdded)} billed` : null,
      Math.abs(c.costAdded) >= MONEY_EPSILON ? `${formatCurrency(c.costAdded)} in costs` : null,
    ].filter(Boolean);
    parts.push(money.length ? `New job, ${money.join(" and ")} so far.` : "New job, nothing billed or spent yet.");
  } else {
    if (c.statusChange === "completed") parts.push("Marked completed.");
    if (c.statusChange === "reopened") parts.push("Marked active again.");
    const money = [billedPhrase(c.revenueAdded), costPhrase(c.costAdded)].filter(Boolean) as string[];
    if (money.length) parts.push(`${capitalize(money.join(", "))}.`);
    const margin = marginPhrase(c.marginBefore, c.marginAfter);
    if (margin) parts.push(margin);
  }

  if (c.nowOverBudgetPct != null) {
    parts.push(`Now ${Math.round(c.nowOverBudgetPct * 100)}% over its estimate.`);
  }

  if (c.estimateAfter != null && c.estimateBefore == null && !c.isNew) {
    parts.push(`Estimate added (${formatCurrency(c.estimateAfter)}).`);
  } else if (c.estimateAfter != null && c.estimateBefore != null && c.estimateAfter !== c.estimateBefore) {
    parts.push(`Estimate changed from ${formatCurrency(c.estimateBefore)} to ${formatCurrency(c.estimateAfter)}.`);
  } else if (c.estimateAfter == null && c.estimateBefore != null) {
    parts.push("Estimate removed.");
  }

  // A completed line reads as a final result, so it carries the finishing
  // margin even when that margin didn't move this week.
  if (c.statusChange === "completed" && c.marginAfter != null && !parts.some((p) => p.startsWith("Margin"))) {
    parts.push(`Finished at ${formatPct(c.marginAfter)} margin.`);
  }

  return parts.join(" ");
}

/**
 * The plain-text "What changed" section, exactly as the customer sees it.
 * Plain text because the brief is sent as text (and as that same text in a
 * <pre> for HTML clients), so anything richer would arrive as symbols.
 */
export function renderWeekOverWeek(report: WeekOverWeekReport): string {
  if (report.noComparisonReason === "first_brief") {
    return [
      "WHAT CHANGED SINCE LAST WEEK",
      "This is the first Weekly Profit Brief for this company, so there is nothing to compare against yet. From next week, this section lists what moved in your books since the previous brief.",
    ].join("\n");
  }
  if (report.noComparisonReason === "unreadable_snapshot" || !report.comparedToWeekStarting) {
    return [
      "WHAT CHANGED SINCE LAST WEEK",
      "The previous brief's figures couldn't be read, so there's no comparison this week. Next week's brief will compare against this one.",
    ].join("\n");
  }

  const since = formatShortDate(report.comparedToWeekStarting);
  const heading = `WHAT CHANGED SINCE THE BRIEF FOR THE WEEK OF ${since.toUpperCase()}`;

  if (report.changes.length === 0) {
    return [heading, "Nothing changed on your jobs in QuickBooks since then."].join("\n");
  }

  const lines: string[] = [heading];

  const money = [billedPhrase(report.revenueAdded), costPhrase(report.costAdded)].filter(Boolean) as string[];
  const totalLine = money.length
    ? `Across all jobs: ${money.join(" and ")}.`
    : "No new billing or costs across your jobs.";
  const blended =
    report.marginAfter == null
      ? ""
      : report.marginBefore == null || Math.abs(report.marginAfter - report.marginBefore) < 0.0005
        ? ` Blended margin ${formatPct(report.marginAfter)}.`
        : ` Blended margin ${formatPct(report.marginAfter)}, ${
            report.marginAfter < report.marginBefore ? "down" : "up"
          } from ${formatPct(report.marginBefore)}.`;
  lines.push(totalLine + blended, "");

  const shown = report.changes.slice(0, MAX_JOB_LINES);
  for (const c of shown) lines.push(renderJobLine(c));

  const hidden = report.changes.length - shown.length;
  const tail: string[] = [];
  if (hidden > 0) tail.push(`${hidden} more ${hidden === 1 ? "job" : "jobs"} also changed. Each job page has its full history.`);
  if (report.unchangedJobs > 0) {
    tail.push(`${report.unchangedJobs} other ${report.unchangedJobs === 1 ? "job" : "jobs"} had no changes.`);
  }
  if (tail.length) lines.push("", tail.join(" "));

  return lines.join("\n");
}

/**
 * A compact form for the model's input, so the narrative can refer to what
 * changed without being handed the rendered text to paraphrase.
 */
export function weekOverWeekForModel(report: WeekOverWeekReport) {
  return {
    comparedToWeekStarting: report.comparedToWeekStarting?.toISOString().slice(0, 10) ?? null,
    noComparisonReason: report.noComparisonReason,
    revenueAddedSinceLastBrief: Math.round(report.revenueAdded),
    costAddedSinceLastBrief: Math.round(report.costAdded),
    blendedMarginBefore: report.marginBefore,
    blendedMarginNow: report.marginAfter,
    jobsChanged: report.changes.map((c) => ({
      jobName: c.jobName,
      isNew: c.isNew,
      removed: c.removed,
      statusChange: c.statusChange,
      costAdded: Math.round(c.costAdded),
      revenueAdded: Math.round(c.revenueAdded),
      marginBefore: c.marginBefore,
      marginNow: c.marginAfter,
      wentOverBudgetThisWeek: c.nowOverBudgetPct != null,
    })),
    jobsUnchanged: report.unchangedJobs,
  };
}
