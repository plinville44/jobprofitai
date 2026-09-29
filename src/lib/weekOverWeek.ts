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
  noComparisonReason: "first_brief" | "unreadable_snapshot" | "basis_changed" | null;
  /** With "basis_changed": what changed, so the brief can say it plainly. */
  basisChange?: BasisChange | null;
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

// --- Basis changes ------------------------------------------------------
//
// A stored snapshot can only be compared with today's figures when both
// were worked out on the same terms. Four things change the terms without
// anything happening on the jobs, and every comparison with an earlier
// week (the "What changed" section, the "new margin risk" headline, the
// alert baseline) uses the same rule, here, for all of them:
//   - the labor burden setting (laborBurdenSetAt);
//   - how jobs are set up, time-entry labor turned on or off, or a full
//     sync that rebuilt the rows under a new sync version (basisChangedAt);
//   - a brief built while such a rebuild was still waiting for its sync
//     (stored with basisPending, since its figures are the old ones);
//   - the sync version itself, stored with each snapshot from now on.

export type BasisChange = "labor_burden" | "setup";

export interface BasisInfo {
  laborBurdenSetAt?: Date | null;
  basisChangedAt?: Date | null;
  /** The connection's sync version now. */
  syncVersion?: number | null;
}

/** The later of the two dates that end comparisons, or null. For code that filters old snapshots by date. */
export function basisCutoff(c: { laborBurdenSetAt?: Date | null; basisChangedAt?: Date | null }): Date | null {
  const a = c.laborBurdenSetAt ?? null;
  const b = c.basisChangedAt ?? null;
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}

/**
 * A job rebuild that Settings asked for and no full sync has done yet: the
 * stored rows are still the old ones, whatever the settings now say.
 */
export function rebuildPending(c: { rebuildRequestedAt?: Date | null; lastFullSyncAt?: Date | null }): boolean {
  if (!c.rebuildRequestedAt) return false;
  return !c.lastFullSyncAt || c.lastFullSyncAt < c.rebuildRequestedAt;
}

function storedField(metrics: unknown, key: string): unknown {
  return metrics && typeof metrics === "object" ? (metrics as Record<string, unknown>)[key] : undefined;
}

/** When a snapshot's figures were worked out: stored with it since this change, otherwise its row's creation. */
function snapshotTime(prior: { metrics: unknown; createdAt?: Date | null }): Date | null {
  const built = storedField(prior.metrics, "builtAt");
  if (typeof built === "string") {
    const d = new Date(built);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return prior.createdAt ?? null;
}

/**
 * Whether a stored snapshot was worked out on other terms than today's
 * figures, and why. Null means it can be compared.
 */
export function basisChangeSince(
  prior: { metrics: unknown; createdAt?: Date | null },
  basis: BasisInfo | null
): BasisChange | null {
  if (storedField(prior.metrics, "basisPending") === true) return "setup";
  const at = snapshotTime(prior);
  // Snapshots stored before this was added carry no version; for those,
  // the date the sync set when it rebuilt the rows (basisChangedAt) decides.
  const storedVersion = storedField(prior.metrics, "syncVersion");
  const version = basis?.syncVersion ?? null;
  if (version != null && typeof storedVersion === "number" && storedVersion !== version) return "setup";
  if (!at || !basis) return null;
  const burden = basis.laborBurdenSetAt && at < basis.laborBurdenSetAt ? basis.laborBurdenSetAt : null;
  const setup = basis.basisChangedAt && at < basis.basisChangedAt ? basis.basisChangedAt : null;
  if (burden && setup) return burden > setup ? "labor_burden" : "setup";
  if (burden) return "labor_burden";
  if (setup) return "setup";
  return null;
}

export function computeWeekOverWeek(
  prior: { weekStarting: Date; metrics: unknown; createdAt?: Date } | null,
  current: ConnectionMetrics,
  /**
   * What decides whether the snapshot was worked out on the same terms (see
   * basisChangeSince). A plain date is the labor burden's change date. A
   * snapshot from before a change would otherwise report every job with
   * time entries as having new costs and a falling margin.
   */
  basis: Date | BasisInfo | null = null
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
  const basisChange = basisChangeSince(prior, basis instanceof Date ? { laborBurdenSetAt: basis } : basis);
  if (basisChange) {
    return { ...empty, comparedToWeekStarting: null, noComparisonReason: "basis_changed", basisChange };
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
/** Why there's no "what changed" section this week, in a sentence. */
export function noComparisonMessage(
  reason: WeekOverWeekReport["noComparisonReason"],
  basisChange: BasisChange | null = "labor_burden"
): string {
  if (reason === "first_brief") {
    return "This is the first Weekly Profit Brief for this company, so there is nothing to compare against yet. From next week, this section lists what moved in your books since the previous brief.";
  }
  if (reason === "basis_changed" && basisChange === "setup") {
    return "How this company's figures are worked out changed since the last brief (how jobs are set up, whether labor comes from time entries, or an update to how JobProfitAI reads QuickBooks). This week's costs and margins aren't measured the same way as last week's, so they aren't compared. Next week's brief will compare against this one.";
  }
  if (reason === "basis_changed") {
    return "Your labor burden setting changed since the last brief, so this week's costs and margins aren't measured the same way as last week's and aren't compared. Next week's brief will compare against this one.";
  }
  return "The previous brief's figures couldn't be read, so there's no comparison this week. Next week's brief will compare against this one.";
}

export function renderWeekOverWeek(report: WeekOverWeekReport): string {
  if (report.noComparisonReason || !report.comparedToWeekStarting) {
    return ["WHAT CHANGED SINCE LAST WEEK", noComparisonMessage(report.noComparisonReason, report.basisChange ?? "labor_burden")].join("\n");
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
    basisChange: report.basisChange ?? null,
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
