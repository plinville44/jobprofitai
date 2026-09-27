import { formatCurrency } from "./format";
import type { OpportunityFeed } from "./opportunities";

/**
 * The line the Weekly Profit Brief leads with: money, not a report.
 *
 * Pure. The feed is summarized into a snapshot that is stored with each
 * brief (WeeklyDigest.metrics.opportunities), so next week's brief can say
 * what's NEW: margin risk on open jobs that wasn't there, or was smaller,
 * last time.
 */

export interface BriefOpportunitySnapshot {
  /** Whether a target margin is set, without which every figure below is zero. */
  targetSet: boolean;
  pricingGap: number;
  openJobRisk: number;
  openJobsAtRisk: number;
  estimatesShortfall: number;
  estimatesFlagged: number;
  unbilledWork: number;
  /**
   * What could be checked. Optional because snapshots stored before these
   * were added don't have them; read as "unknown", never as zero.
   */
  jobsJudged?: number;
  openJobsChecked?: number;
  billingChecked?: number;
  /** Risk on each open job, to find what's new next week. */
  openRiskByJob: Record<string, number>;
  /** The biggest few items, for the email. */
  top: { title: string; impact: number | null; impactLabel: string; impactKind: "profit" | "cash"; href: string }[];
}

export function snapshotFromFeed(feed: OpportunityFeed): BriefOpportunitySnapshot {
  const openRiskByJob: Record<string, number> = {};
  for (const i of feed.items) {
    if ((i.kind === "open_job_forecast" || i.kind === "open_job_over_estimate") && i.jobIds[0] && i.impact != null) {
      openRiskByJob[i.jobIds[0]] = (openRiskByJob[i.jobIds[0]] ?? 0) + i.impact;
    }
  }
  const top = feed.items
    .filter((i) => i.section !== "working" && i.impact != null && i.impactKind === "profit")
    .sort((a, b) => (b.impact ?? 0) - (a.impact ?? 0))
    .slice(0, 3)
    .map((i) => ({
      title: i.title,
      impact: i.impact,
      impactLabel: i.impactLabel,
      impactKind: i.impactKind,
      href: i.href ?? `/dashboard/opportunities#${encodeURIComponent(i.id)}`,
    }));
  const s = feed.summary;
  return {
    targetSet: s.targetSet,
    pricingGap: round(s.pricingGap),
    openJobRisk: round(s.openJobRisk),
    openJobsAtRisk: s.openJobsAtRisk,
    estimatesShortfall: round(s.estimatesShortfall),
    estimatesFlagged: s.estimatesFlagged,
    unbilledWork: round(s.unbilledWork),
    jobsJudged: s.jobsJudged,
    openJobsChecked: s.openJobsChecked,
    billingChecked: s.billingChecked,
    openRiskByJob,
    top,
  };
}

const round = (n: number) => Math.round(n * 100) / 100;

export interface BriefHeadline {
  snapshot: BriefOpportunitySnapshot;
  /** New or grown risk on open jobs since the last brief; null with nothing to compare. */
  newRisk: number | null;
  headline: string;
  /** A subject line with the money in it, or null to keep the usual one. */
  subject: string | null;
}

function priorRiskByJob(priorMetrics: unknown): Record<string, number> | null {
  const o = (priorMetrics as { opportunities?: { openRiskByJob?: unknown } } | null)?.opportunities;
  if (!o || typeof o.openRiskByJob !== "object" || o.openRiskByJob == null) return null;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(o.openRiskByJob as Record<string, unknown>)) if (typeof v === "number") out[k] = v;
  return out;
}

const MIN_NEWS = 500;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function computeBriefHeadline(snapshot: BriefOpportunitySnapshot, priorMetrics: unknown, companyName: string): BriefHeadline {
  const prior = priorRiskByJob(priorMetrics);
  let newRisk: number | null = null;
  if (prior) {
    newRisk = 0;
    for (const [jobId, risk] of Object.entries(snapshot.openRiskByJob)) newRisk += Math.max(0, risk - (prior[jobId] ?? 0));
    newRisk = round(newRisk);
  }

  if (newRisk != null && newRisk >= MIN_NEWS) {
    return {
      snapshot,
      newRisk,
      headline: `JobProfitAI found ${formatCurrency(newRisk)} of new margin risk on your open jobs since the last brief.`,
      subject: `${companyName}: ${formatCurrency(newRisk)} of new margin risk this week`,
    };
  }
  if (snapshot.estimatesFlagged > 0) {
    return {
      snapshot,
      newRisk,
      headline: `${plural(snapshot.estimatesFlagged, "pending estimate")} ${snapshot.estimatesFlagged === 1 ? "looks" : "look"} ${formatCurrency(snapshot.estimatesShortfall)} light against your target margin.`,
      subject: `${companyName}: ${plural(snapshot.estimatesFlagged, "estimate")} priced below your target`,
    };
  }
  if (!snapshot.targetSet) {
    return { snapshot, newRisk, headline: "Set a target margin in Settings to see what your pricing is costing you.", subject: null };
  }
  // Smaller amounts are still said as they are, never rounded down to "none".
  if (newRisk != null && newRisk > 0) {
    return { snapshot, newRisk, headline: `${formatCurrency(newRisk)} of new margin risk on your open jobs since the last brief.`, subject: null };
  }
  if (snapshot.openJobRisk > 0) {
    return {
      snapshot,
      newRisk,
      headline: `${formatCurrency(snapshot.openJobRisk)} is at risk on ${plural(snapshot.openJobsAtRisk, "open job")}.`,
      subject: null,
    };
  }
  if (snapshot.pricingGap >= 1) {
    return {
      snapshot,
      newRisk,
      headline: `Bringing the kinds of work that ran below target up to your target margins would have added ${formatCurrency(snapshot.pricingGap)} on the jobs you finished in the last 12 months.`,
      subject: null,
    };
  }
  return { snapshot, newRisk, headline: allClearHeadline(snapshot), subject: null };
}

/**
 * Nothing to flag. Says what was actually checked, so "nothing found"
 * can't be read as "all fine" when there was nothing to look at: a company
 * with no finished jobs and no cost estimates would otherwise be told its
 * jobs are all on target.
 */
function allClearHeadline(s: BriefOpportunitySnapshot): string {
  const judged = s.jobsJudged;
  const open = s.openJobsChecked;
  if (judged == null || open == null) {
    return "Nothing on your open jobs or your recent pricing needs attention this week.";
  }
  if (judged === 0 && open === 0) {
    return "There wasn't enough in QuickBooks to check against your target this week: no jobs finished in the last 12 months with revenue and costs, and no open job with a cost estimate or a firm forecast.";
  }
  const openPart =
    open === 0
      ? "no open job has a cost estimate or a firm forecast to check yet"
      : open === 1
        ? "the 1 open job we could check isn't heading below target"
        : `none of the ${open} open jobs we could check is heading below target`;
  const finishedPart =
    judged === 0
      ? "no jobs finished in the last 12 months have revenue and costs to judge yet"
      : `your ${plural(judged, "job")} finished in the last 12 months ${judged === 1 ? "is" : "average"} at or above your target`;
  const sentence = `${finishedPart[0].toUpperCase()}${finishedPart.slice(1)}, and ${openPart}.`;
  return sentence;
}
