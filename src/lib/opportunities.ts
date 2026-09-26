// ============================================================================
// PROFIT OPPORTUNITY FEED
// ----------------------------------------------------------------------------
// Turns the numbers computeJobFinancials already produced into ranked,
// dollar-valued things to change, each with the evidence behind it, what to
// do, and how the figure was worked out.
//
// Pure, like the calculation layer in profitability.ts: plain data in, plain
// data out, no database, no clock (`now` is passed in), no AI. Every dollar
// figure here is arithmetic on synced QuickBooks data and the contractor's
// own targets, and the arithmetic is stated in each item's `method`.
//
// Three ideas carry the whole file:
//
//  1. "Priced to target." A job that cost C and sold for R would have needed
//     C / (1 - target) to hit its target margin (each job at its own
//     target). The difference is the profit a price at target would have
//     added on the same work. It assumes the same costs, and that the
//     customer would still have bought.
//
//  2. "What you charged for each part." A QuickBooks estimate's lines say
//     how the price was split between labor, materials, subs and equipment.
//     Applied to what was actually invoiced, that gives what the customer
//     paid for each part, to set against what each part actually cost.
//     Lines and costs outside those four (markup, fees, overhead) are spread
//     across them in proportion, so the parts add up to the whole job on
//     both sides. A job whose split and costs don't line up (a part that
//     cost money but was never priced, or was priced with no cost recorded)
//     is left out of every by-part figure, because it would name the wrong
//     part as thin.
//
//  3. Lenses overlap; totals don't. One remodel for a repeat customer can
//     sit under its job type, its size and its customer. The items are
//     different ways of looking at the same jobs, so they are never added
//     up. The headline is computed per job, once each, and no item's figure
//     can exceed it.
// ============================================================================

import type { ForecastResult, JobFinancials } from "./profitability";
import type { CostCategory, EstimateLine } from "./qboNormalize";
import { formatCurrency } from "./format";

export const CORE_CATEGORIES = ["labor", "materials", "subcontractor", "equipment"] as const;
export type CoreCategory = (typeof CORE_CATEGORIES)[number];

/** Finished work this recent is what pricing advice is built from. */
export const PRICING_WINDOW_DAYS = 365;
/** The Estimate Check looks further back, for enough comparable jobs. */
export const HISTORY_WINDOW_DAYS = 730;
/** Fewest jobs any pattern is drawn from. */
export const MIN_JOBS = 3;
/** An estimate must put at least this share of its price in the four core categories to show a split. */
export const MIN_MIX_COVERAGE = 0.5;
/** Targets are accepted up to this (percent); above it no job could reach them. */
export const MAX_TARGET_PCT = 90;

const DAY = 86_400_000;

/** A part of the job as a noun phrase that reads in any sentence. */
const PART_NAMES: Record<CoreCategory, string> = {
  labor: "labor",
  materials: "materials",
  subcontractor: "subcontracted work",
  equipment: "equipment",
};
const capitalize = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const pct = (f: number, digits = 1) => `${(f * 100).toFixed(digits)}%`;
/** A target exactly as set: "28%", or "27.5%". Never rounded into a different target. */
export const fmtTarget = (fraction: number) => `${parseFloat((fraction * 100).toFixed(2))}%`;
/** "Subcontracted work earned 20.0%, materials earned 38.0%" */
const othersSentence = (parts: { category: CoreCategory; marginPct: number }[]) =>
  capitalize(parts.map((o) => `${PART_NAMES[o.category]} earned ${pct(o.marginPct)}`).join(", "));
/** A price increase, rounded up to a whole percent so following it always reaches the target. */
const upPct = (f: number) => `${Math.max(1, Math.ceil(f * 100 - 1e-9))}%`;
const money = (n: number) => formatCurrency(n);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** "Brightline Builders'" and "Acme's". */
const possessive = (name: string) => (/s$/i.test(name) ? `${name}'` : `${name}'s`);
/**
 * A job type as it reads mid-sentence: "kitchen remodel", "HVAC" (acronyms
 * keep their capitals), and the built-in Other in quotes so "Other jobs"
 * isn't read as "the other jobs".
 */
export function typePhrase(label: string): string {
  if (label.trim().toLowerCase() === "other") return "“Other”";
  return label
    .split(/\s+/)
    .map((w) => (/^[A-Z0-9&]{2,}$/.test(w) ? w : w.toLowerCase()))
    .join(" ");
}

// ---------------------------------------------------------------------------
// Estimate mix: how a job's price was split between the parts of the work
// ---------------------------------------------------------------------------

export interface PricedMix {
  /** Share of the core-category price in each category; the present ones sum to 1. */
  shares: Partial<Record<CoreCategory, number>>;
  /** Share of the estimates' total price that sits in the four core categories. */
  coverage: number;
  /** Total price on the estimates the mix came from. */
  quoted: number;
}

export interface StoredEstimate {
  amount: number;
  status: string;
  txnDate: Date;
  lines: EstimateLine[] | null;
}

/**
 * The estimates behind a job's contract value, by the same rule as
 * contractValueFromEstimates: every accepted one (the quote plus signed
 * change orders), or with none accepted, the latest pending one.
 */
export function contractEstimates<T extends { amount: number; status: string; txnDate: Date }>(estimates: T[]): T[] {
  const live = estimates.filter((e) => e.status.toLowerCase() !== "rejected" && e.amount > 0);
  if (live.length === 0) return [];
  const accepted = live.filter((e) => ["accepted", "closed", "converted"].includes(e.status.toLowerCase()));
  if (accepted.length > 0) return accepted;
  return [live.reduce((a, b) => (b.txnDate > a.txnDate ? b : a))];
}

/**
 * The price split of a set of estimate lines, or null when they don't split
 * the work. Credit lines count against their own part ("Labor credit"
 * reduces labor), and a part that nets to nothing is dropped.
 */
export function pricedMixFromLines(lines: EstimateLine[]): PricedMix | null {
  const total = lines.reduce((s, l) => s + l.a, 0);
  if (total <= 0) return null;
  const net: Partial<Record<CoreCategory, number>> = {};
  for (const l of lines) {
    if ((CORE_CATEGORIES as readonly string[]).includes(l.c)) net[l.c as CoreCategory] = (net[l.c as CoreCategory] ?? 0) + l.a;
  }
  const core = Object.entries(net).filter(([, v]) => (v ?? 0) > 0) as [CoreCategory, number][];
  const coreTotal = core.reduce((s, [, v]) => s + v, 0);
  const coverage = coreTotal / total;
  if (coreTotal <= 0 || coverage < MIN_MIX_COVERAGE) return null;
  // One category only is no split: it says nothing about which part is thin.
  if (core.length < 2) return null;
  const shares: Partial<Record<CoreCategory, number>> = {};
  for (const [k, v] of core) shares[k] = v / coreTotal;
  return { shares, coverage, quoted: total };
}

/** A job's price split from all its stored estimates. */
export function pricedMixForJob(estimates: StoredEstimate[]): PricedMix | null {
  const used = contractEstimates(estimates);
  if (used.length === 0 || used.some((e) => e.lines == null || e.lines.length === 0)) return null;
  return pricedMixFromLines(used.flatMap((e) => e.lines ?? []));
}

/**
 * What each core category actually cost on a job, with costs in any other
 * category (overhead, other) spread across them in proportion, so the four
 * add up to the job's whole cost. Null when nothing was in a core category.
 */
export function coreActuals(f: Pick<JobFinancials, "costs" | "costByCategory">): Partial<Record<CoreCategory, number>> | null {
  let coreTotal = 0;
  for (const k of CORE_CATEGORIES) coreTotal += Math.max(0, f.costByCategory[k] ?? 0);
  if (coreTotal <= 0 || f.costs <= 0) return null;
  const scale = f.costs / coreTotal;
  const out: Partial<Record<CoreCategory, number>> = {};
  for (const k of CORE_CATEGORIES) {
    const v = Math.max(0, f.costByCategory[k] ?? 0);
    if (v > 0) out[k] = v * scale;
  }
  return out;
}

/**
 * Whether a job's price split and its costs describe the same parts. A part
 * that cost 5% or more of the job but was never priced (subs paid by bill on
 * an estimate that only lists labor and materials), or one priced at 10% or
 * more with almost no cost recorded (labor that was never booked to the
 * job), would make a healthy part look thin or a thin one look healthy.
 */
export function partsComparable(f: Pick<JobFinancials, "costs" | "costByCategory" | "revenue">, mix: PricedMix): boolean {
  if (f.revenue <= 0) return false;
  const actual = coreActuals(f);
  if (!actual) return false;
  const total = Object.values(actual).reduce((s, v) => s + (v ?? 0), 0);
  for (const k of CORE_CATEGORIES) {
    const share = mix.shares[k] ?? 0;
    const costShare = (actual[k] ?? 0) / total;
    if (costShare >= 0.05 && share <= 0) return false;
    if (share >= 0.1 && costShare <= 0.02) return false;
  }
  return true;
}

/** The jobs whose split can be used part by part. */
export function usableSplits<T extends { f: JobFinancials; mix: PricedMix }>(jobs: T[]): T[] {
  return jobs.filter((j) => partsComparable(j.f, j.mix));
}

export interface CategoryResult {
  category: CoreCategory;
  /** What customers paid for this part: invoiced revenue x the estimate's share. */
  charged: number;
  /** What this part cost, including its share of uncategorized costs. */
  cost: number;
  /** 1 - cost / charged. */
  marginPct: number;
  /** Share of the price this part accounts for. */
  shareOfPrice: number;
}

/**
 * Charged versus cost for each part of the work, over finished jobs whose
 * split and costs line up (see partsComparable; others are skipped here
 * too). Over those jobs, charged and cost each add up to the whole job.
 */
export function categoryResults(jobs: { f: JobFinancials; mix: PricedMix }[]): CategoryResult[] {
  const charged: Partial<Record<CoreCategory, number>> = {};
  const cost: Partial<Record<CoreCategory, number>> = {};
  let revenue = 0;
  for (const { f, mix } of usableSplits(jobs)) {
    const actual = coreActuals(f)!;
    // Small costs in a part this job's estimate didn't price (under the 5%
    // partsComparable allows) are spread across the parts it did price, in
    // proportion, so the priced parts still add up to the whole job's cost.
    const priced = CORE_CATEGORIES.filter((k) => (mix.shares[k] ?? 0) > 0);
    const pricedCost = priced.reduce((s, k) => s + (actual[k] ?? 0), 0);
    const unpricedCost = CORE_CATEGORIES.filter((k) => !((mix.shares[k] ?? 0) > 0)).reduce((s, k) => s + (actual[k] ?? 0), 0);
    revenue += f.revenue;
    for (const k of priced) {
      const own = actual[k] ?? 0;
      const share = pricedCost > 0 ? own / pricedCost : 1 / priced.length;
      charged[k] = (charged[k] ?? 0) + (mix.shares[k] ?? 0) * f.revenue;
      cost[k] = (cost[k] ?? 0) + own + unpricedCost * share;
    }
  }
  if (revenue <= 0) return [];
  return CORE_CATEGORIES.filter((k) => (charged[k] ?? 0) > 0)
    .map((k) => ({
      category: k,
      charged: charged[k]!,
      cost: cost[k] ?? 0,
      marginPct: 1 - (cost[k] ?? 0) / charged[k]!,
      shareOfPrice: charged[k]! / revenue,
    }))
    .sort((a, b) => a.marginPct - b.marginPct);
}

// ---------------------------------------------------------------------------
// The basis: finished jobs with numbers that can be judged
// ---------------------------------------------------------------------------

interface BasisJob {
  f: JobFinancials;
  revenue: number;
  cost: number;
  margin: number;
  /** Target as a fraction, or null when none is set. */
  target: number | null;
}

export const targetFraction = (pctValue: number | null | undefined): number | null =>
  pctValue == null || !Number.isFinite(pctValue) || pctValue <= 0 || pctValue > MAX_TARGET_PCT ? null : pctValue / 100;

/** Finished jobs with revenue and costs whose last activity falls in the window. */
function finishedBasis(jobs: JobFinancials[], now: Date, windowDays: number): BasisJob[] {
  const since = now.getTime() - windowDays * DAY;
  return jobs
    .filter(
      (f) =>
        f.status === "closed" &&
        f.profitabilityAvailable &&
        f.revenue > 0 &&
        f.costs > 0 &&
        f.grossMarginPct != null &&
        f.lastFinancialActivity != null &&
        f.lastFinancialActivity.getTime() >= since
    )
    .map((f) => ({
      f,
      revenue: f.revenue,
      cost: f.costs,
      margin: f.grossMarginPct!,
      target: targetFraction(f.targetMarginPct),
    }));
}

/** The price a job needed to hit its own target. */
const priceAtTarget = (j: BasisJob) => j.cost / (1 - j.target!);

interface GroupStats {
  n: number;
  revenue: number;
  cost: number;
  margin: number;
  /** True when every job in the group has a target. */
  allTargets: boolean;
  /** The target when every job shares one, else null. */
  uniformTarget: number | null;
  /** "your 28% target", or "your targets" when the jobs' targets differ. */
  targetText: string;
  below: number;
  /** Sum of each job's price at its own target. */
  needed: number;
  /** Profit pricing the group at target adds on the same work: needed - revenue, never negative. */
  gapToTarget: number;
  /** Price increase across the group that reaches the targets. */
  priceIncrease: number | null;
}

function groupStats(group: BasisJob[]): GroupStats {
  const revenue = group.reduce((s, j) => s + j.revenue, 0);
  const cost = group.reduce((s, j) => s + j.cost, 0);
  const margin = revenue > 0 ? 1 - cost / revenue : 0;
  const allTargets = group.length > 0 && group.every((j) => j.target != null);
  const first = group[0]?.target ?? null;
  const uniformTarget = allTargets && group.every((j) => Math.abs(j.target! - first!) < 1e-9) ? first : null;
  const needed = allTargets ? group.reduce((s, j) => s + priceAtTarget(j), 0) : 0;
  const gapToTarget = allTargets ? Math.max(0, needed - revenue) : 0;
  return {
    n: group.length,
    revenue,
    cost,
    margin,
    allTargets,
    uniformTarget,
    targetText: uniformTarget != null ? `your ${fmtTarget(uniformTarget)} target` : "your targets",
    below: group.filter((j) => j.target != null && j.margin < j.target).length,
    needed,
    gapToTarget,
    priceIncrease: allTargets && revenue > 0 && needed > revenue ? needed / revenue - 1 : null,
  };
}

/** A group is worth an item when reaching its targets takes at least a 1% price rise. */
const worthAnItem = (s: GroupStats) => s.priceIncrease != null && s.priceIncrease >= 0.01 && s.gapToTarget > 0;

function groupConfidence(s: GroupStats, one: string, many: string): { confidence: "high" | "medium" | "low"; reason: string } {
  const share = s.n > 0 ? s.below / s.n : 0;
  const reason = `Based on ${plural(s.n, one, many)}, ${s.below} of them below target.`;
  if (s.n >= 6 && share >= 2 / 3) return { confidence: "high", reason };
  if (share >= 0.5) return { confidence: "medium", reason };
  return { confidence: "low", reason: `${reason} The rest did better, so this is a lead to check rather than a rule.` };
}

// ---------------------------------------------------------------------------
// Feed items
// ---------------------------------------------------------------------------

export type FeedItemKind =
  | "estimate_below_target"
  | "open_job_forecast"
  | "open_job_over_estimate"
  | "underbilled"
  | "job_type_pricing"
  | "category_pricing"
  | "small_jobs"
  | "customer_pricing"
  | "estimate_overrun"
  | "strong_job_type";

export type FeedSection = "act_now" | "pricing" | "working";

/** Items whose figure is extra profit from a price change, shown with a "+". */
export const GAIN_KINDS: ReadonlySet<FeedItemKind> = new Set([
  "job_type_pricing",
  "category_pricing",
  "small_jobs",
  "customer_pricing",
  "estimate_below_target",
]);

export interface TrackableChange {
  kind: "job_type" | "customer" | "small_jobs" | "cost_category";
  subjectKey: string;
  costCategory: CoreCategory | null;
  baselineMarginPct: number;
  baselineJobs: number;
  baselineRevenue: number;
  targetMarginPct: number | null;
}

export interface FeedItem {
  /** Stable across page loads, e.g. "job_type_pricing:remodel". */
  id: string;
  kind: FeedItemKind;
  section: FeedSection;
  title: string;
  /** Dollars. Null for findings with no fair dollar figure. */
  impact: number | null;
  /** What the dollars are: "more profit a year", "to bill", ... */
  impactLabel: string;
  /** "cash" items (unbilled work) are money owed, not extra profit, and are kept out of profit totals. */
  impactKind: "profit" | "cash";
  confidence: "high" | "medium" | "low";
  confidenceReason: string;
  /** What the numbers show. */
  finding: string;
  /** Why, when the data says. */
  cause: string | null;
  /** What to do. */
  action: string;
  /** How the figure was worked out, in plain words. */
  method: string;
  jobIds: string[];
  /** Where to act: a job page or the Estimate Check. */
  href: string | null;
  /** Per-part breakdown rows, when there is one. */
  breakdown: CategoryResult[] | null;
  /** Set on pricing changes the contractor can say they're making and have measured. */
  trackable: TrackableChange | null;
}

export interface FeedSummary {
  /** False when no target margin is set anywhere, which switches most of the feed off. */
  targetSet: boolean;
  /** Profit prices at target would have added on jobs finished in the last 12 months, each job counted once. */
  pricingGap: number;
  jobsBelowTarget: number;
  jobsJudged: number;
  /** Profit short of target on open jobs (forecast), or already spent past estimate where there's no forecast. */
  openJobRisk: number;
  openJobsAtRisk: number;
  /** Price missing from pending estimates the check flagged. */
  estimatesShortfall: number;
  estimatesFlagged: number;
  /** Work done and not billed yet. Cash, not profit. */
  unbilledWork: number;
}

export interface SetupHint {
  code: "no_target" | "untyped_jobs" | "no_estimate_split" | "idle_open_jobs" | "no_finished_jobs";
  message: string;
  href: string;
  linkText: string;
}

export interface OpportunityFeed {
  summary: FeedSummary;
  items: FeedItem[];
  setup: SetupHint[];
  /** Finished jobs in the last 12 months that the pricing lenses looked at. */
  finishedJobsConsidered: number;
}

export interface EstimateFeedEntry {
  estimateId: string;
  label: string;
  shortfall: number;
  predictedMarginPct: number;
  targetMarginPct: number;
  confidence: "high" | "medium" | "low";
  confidenceReason: string;
  /** QuickBooks hasn't emailed it. (It may still have gone out on paper or as a PDF.) */
  notEmailed: boolean;
  typeLabel: string;
  historyJobs: number;
}

export interface FeedInput {
  now: Date;
  /** Every job, whole life (not a dashboard period). */
  jobs: JobFinancials[];
  /** Forecasts for open jobs, present only on plans with forecasting. */
  forecasts: Map<string, ForecastResult>;
  /** Price split per job, for jobs whose estimates split the work. */
  mixes: Map<string, PricedMix>;
  /** Jobs whose estimated cost came from "fill from target margin" rather than the contractor. */
  targetFilledEstimates?: Set<string>;
  typeLabel: (key: string) => string;
  /** Flagged pending estimates, from computeEstimateCheck. */
  estimateFlags: EstimateFeedEntry[];
  /** Whether the company's jobs are QuickBooks customers (one customer per job): the customer lens is meaningless then. */
  jobsAreCustomers?: boolean;
  /** Open jobs idle 90+ days, for the setup hint. */
  idleOpenJobs?: number;
}

/** Rounds a size threshold up to a figure a contractor would say out loud. */
export function niceCeil(n: number): number {
  if (n <= 0) return 0;
  const step = n < 2_000 ? 250 : n < 10_000 ? 500 : n < 50_000 ? 1_000 : n < 200_000 ? 5_000 : 25_000;
  return Math.ceil(n / step) * step;
}

const METHOD_PRICED =
  "A job that cost C needed to sell for C / (1 - target) to hit its target margin. The figure is that price minus what the jobs actually sold for, over the group as a whole. It assumes the same costs, and that customers would still have bought at the higher price.";

export function computeOpportunityFeed(input: FeedInput): OpportunityFeed {
  const { now, jobs, forecasts, mixes, typeLabel } = input;
  const items: FeedItem[] = [];
  const setup: SetupHint[] = [];

  const basis = finishedBasis(jobs, now, PRICING_WINDOW_DAYS);
  const judged = basis.filter((j) => j.target != null);
  const targetSet = jobs.some((f) => targetFraction(f.targetMarginPct) != null);

  // ---- Headline: each finished job once --------------------------------
  let pricingGap = 0;
  let jobsBelowTarget = 0;
  const jobShortfall = new Map<string, number>();
  for (const j of judged) {
    if (j.margin < j.target!) {
      jobsBelowTarget++;
      const gap = Math.max(0, priceAtTarget(j) - j.revenue);
      pricingGap += gap;
      jobShortfall.set(j.f.jobId, gap);
    }
  }

  // ---- Job types ---------------------------------------------------------
  const byType = new Map<string, BasisJob[]>();
  for (const j of basis) if (j.f.category) byType.set(j.f.category, [...(byType.get(j.f.category) ?? []), j]);
  const typedRevenue = [...byType.values()].flat().reduce((s, j) => s + j.revenue, 0);
  const basisRevenue = basis.reduce((s, j) => s + j.revenue, 0);
  const typeItemsWithCause = new Set<CoreCategory>();

  for (const [key, group] of byType) {
    if (group.length < MIN_JOBS) continue;
    const s = groupStats(group);
    const label = typeLabel(key);
    const phrase = typePhrase(label);
    const one = `finished ${phrase} job`;
    const many = `finished ${phrase} jobs`;
    if (worthAnItem(s)) {
      const { confidence, reason } = groupConfidence(s, one, many);
      // Why: the thinnest part of the price, when the estimates split it.
      const splits = usableSplits(group.filter((j) => mixes.has(j.f.jobId)).map((j) => ({ f: j.f, mix: mixes.get(j.f.jobId)! })));
      const parts = splits.length >= MIN_JOBS ? categoryResults(splits) : [];
      // Parts are compared with the group's (usually single) target.
      const partTarget = s.uniformTarget ?? (s.needed > 0 ? 1 - s.cost / s.needed : 0);
      const weakest = parts.find((p) => p.shareOfPrice >= 0.1 && p.marginPct < partTarget - 0.05) ?? null;
      let cause: string | null = null;
      let action = `Raise prices on ${phrase} jobs by about ${upPct(s.priceIncrease!)}. On the same work, that reaches ${s.targetText}.`;
      let costCategory: CoreCategory | null = null;
      if (weakest) {
        const others = parts.filter((p) => p.category !== weakest.category);
        cause = `The thin part is ${PART_NAMES[weakest.category]}. On the ${splits.length} of these jobs whose estimates split the price, customers paid ${money(weakest.charged)} for ${PART_NAMES[weakest.category]} and it cost ${money(weakest.cost)}, for a margin of ${pct(weakest.marginPct)}${
          others.length ? `. ${othersSentence(others)}` : ""
        }.`;
        // The whole gap, recovered on this part alone.
        const raiseOnPart = s.priceIncrease! / weakest.shareOfPrice;
        action = `Raise the ${PART_NAMES[weakest.category]} line on your ${phrase} estimates by about ${upPct(raiseOnPart)}. That closes the gap on its own; spread across the whole job it's about ${upPct(s.priceIncrease!)}.`;
        costCategory = weakest.category;
        typeItemsWithCause.add(weakest.category);
      } else {
        const withEstimate = group.filter((j) => j.f.varianceVsEstimatePct != null && j.f.varianceVsEstimate != null && !input.targetFilledEstimates?.has(j.f.jobId));
        if (withEstimate.length >= MIN_JOBS) {
          const avgOver = withEstimate.reduce((t, j) => t + j.f.varianceVsEstimatePct!, 0) / withEstimate.length;
          const totalOver = withEstimate.reduce((t, j) => t + Math.max(0, j.f.varianceVsEstimate!), 0);
          if (avgOver > 0.05 && totalOver > 0) {
            cause = `Costs ran an average of ${pct(avgOver, 0)} over estimate on the ${plural(withEstimate.length, "job")} with a cost estimate (${money(totalOver)} over in all), so prices were set on costs that were too low.`;
            action = `Add about ${upPct(avgOver)} to the cost side of your next ${phrase} estimates before you price them, and raise prices on ${phrase} jobs by about ${upPct(s.priceIncrease!)} in all to reach ${s.targetText}.`;
          }
        }
      }
      const partResult = costCategory ? parts.find((p) => p.category === costCategory)! : null;
      items.push({
        id: `job_type_pricing:${key}`,
        kind: "job_type_pricing",
        section: "pricing",
        title: `${capitalize(phrase)} jobs are priced below ${s.targetText}`,
        impact: s.gapToTarget,
        impactLabel: "more profit a year",
        impactKind: "profit",
        confidence,
        confidenceReason: reason,
        finding: `Your ${plural(s.n, one, many)} from the last 12 months earned ${pct(s.margin)} on ${money(s.revenue)} of work, against ${s.targetText}.`,
        cause,
        action,
        method: `${METHOD_PRICED} Jobs finished in the last 12 months, grouped by job type.`,
        jobIds: group.map((j) => j.f.jobId),
        href: null,
        breakdown: parts.length ? parts : null,
        trackable: {
          kind: "job_type",
          subjectKey: key,
          costCategory,
          baselineMarginPct: partResult ? partResult.marginPct : s.margin,
          baselineJobs: partResult ? splits.length : s.n,
          baselineRevenue: partResult ? partResult.charged : s.revenue,
          targetMarginPct: s.uniformTarget != null ? s.uniformTarget * 100 : null,
        },
      });
    } else {
      // What's working: a type well clear of target, and of everything else.
      const rest = basis.filter((j) => j.f.category !== key);
      const restStats = rest.length >= MIN_JOBS ? groupStats(rest) : null;
      const clearOfTarget = s.uniformTarget != null && s.margin >= s.uniformTarget + 0.05;
      const clearOfRest = restStats != null && s.margin >= restStats.margin + 0.08;
      if (clearOfTarget && clearOfRest) {
        items.push({
          id: `strong_job_type:${key}`,
          kind: "strong_job_type",
          section: "working",
          title: `${capitalize(phrase)} jobs are your best work`,
          impact: null,
          impactLabel: "",
          impactKind: "profit",
          confidence: s.n >= 6 ? "high" : "medium",
          confidenceReason: `Based on ${plural(s.n, one, many)}.`,
          finding: `Your ${plural(s.n, one, many)} earned ${pct(s.margin)}, against ${pct(restStats!.margin)} for your other work: ${money(s.revenue - s.cost)} of gross profit on ${money(s.revenue)}.`,
          cause: null,
          action: "Worth more of your sales time and marketing. When you're choosing between bids, this is the work that pays.",
          method: "Jobs finished in the last 12 months. Margin is gross profit divided by revenue, across all the jobs in the group.",
          jobIds: group.map((j) => j.f.jobId),
          href: null,
          breakdown: null,
          trackable: null,
        });
      }
    }
  }

  // ---- The parts of the price, company-wide, when job types don't carry it --
  // Only jobs below target, and only as much of each job's shortfall as the
  // thin part accounts for, so this can never claim more than the headline.
  const typesCoverMost = basisRevenue > 0 && typedRevenue / basisRevenue >= 0.5;
  if (!typesCoverMost) {
    const below = judged.filter((j) => jobShortfall.has(j.f.jobId) && mixes.has(j.f.jobId));
    const splits = usableSplits(below.map((j) => ({ f: j.f, mix: mixes.get(j.f.jobId)!, j })));
    if (splits.length >= MIN_JOBS) {
      const parts = categoryResults(splits);
      const rev = splits.reduce((s, x) => s + x.f.revenue, 0);
      const target = splits.reduce((s, x) => s + x.f.revenue * x.j.target!, 0) / rev;
      const weakest = parts.find((p) => p.shareOfPrice >= 0.1 && p.marginPct < target - 0.05 && !typeItemsWithCause.has(p.category));
      if (weakest) {
        const k = weakest.category;
        let recoverable = 0;
        for (const x of splits) {
          const actual = coreActuals(x.f)!;
          const charged = (x.mix.shares[k] ?? 0) * x.f.revenue;
          const partGap = Math.max(0, (actual[k] ?? 0) / (1 - x.j.target!) - charged);
          recoverable += Math.min(jobShortfall.get(x.f.jobId) ?? 0, partGap);
        }
        if (recoverable > 0) {
          const others = parts.filter((p) => p.category !== k);
          const uniform = splits.every((x) => Math.abs(x.j.target! - splits[0].j.target!) < 1e-9);
          const targetText = uniform ? `your ${fmtTarget(splits[0].j.target!)} target` : "your targets";
          items.push({
            id: `category_pricing:${k}`,
            kind: "category_pricing",
            section: "pricing",
            title: `Your price for ${PART_NAMES[k]} is below ${targetText}`,
            impact: recoverable,
            impactLabel: "more profit a year",
            impactKind: "profit",
            confidence: splits.length >= 6 ? "high" : "medium",
            confidenceReason: `Based on ${plural(splits.length, "finished job")} below target whose QuickBooks estimates split the price.`,
            finding: `On ${plural(splits.length, "finished job")} below target, customers paid ${money(weakest.charged)} for ${PART_NAMES[k]} and it cost ${money(weakest.cost)}, for a margin of ${pct(weakest.marginPct)}.`,
            cause: others.length ? `${othersSentence(others)}.` : null,
            action: `Raise the ${PART_NAMES[k]} line on your estimates by about ${upPct(recoverable / weakest.charged)}.`,
            method:
              "Each job's invoiced revenue is split the way its QuickBooks estimate split the price, and set against what each part actually cost. Estimate lines and costs outside labor, materials, subs and equipment are spread across those four in proportion, so the parts add up to the whole job. The figure is how much of each job's shortfall against its target this part accounts for, added up.",
            jobIds: splits.map((x) => x.f.jobId),
            href: null,
            breakdown: parts,
            trackable: {
              kind: "cost_category",
              subjectKey: "all",
              costCategory: k,
              baselineMarginPct: weakest.marginPct,
              baselineJobs: splits.length,
              baselineRevenue: weakest.charged,
              targetMarginPct: uniform ? splits[0].j.target! * 100 : null,
            },
          });
        }
      }
    }
  }

  // ---- Small jobs --------------------------------------------------------
  if (judged.length >= 8) {
    const sorted = [...judged].sort((a, b) => a.revenue - b.revenue);
    const threshold = niceCeil(sorted[Math.floor(sorted.length / 3) - 1].revenue);
    const small = sorted.filter((j) => j.revenue <= threshold);
    const big = sorted.filter((j) => j.revenue > threshold);
    if (small.length >= MIN_JOBS && big.length >= MIN_JOBS && small.length <= sorted.length / 2) {
      const s = groupStats(small);
      const b = groupStats(big);
      if (worthAnItem(s) && s.margin < b.margin - 0.05) {
        const avgCost = s.cost / s.n;
        const avgNeeded = s.needed / s.n;
        const { confidence, reason } = groupConfidence(s, "finished job this size", "finished jobs this size");
        items.push({
          id: "small_jobs",
          kind: "small_jobs",
          section: "pricing",
          title: `Jobs of ${money(threshold)} or less don't pay`,
          impact: s.gapToTarget,
          impactLabel: "more profit a year",
          impactKind: "profit",
          confidence,
          confidenceReason: reason,
          finding: `Your ${plural(s.n, "finished job")} of ${money(threshold)} or less earned ${pct(s.margin)}. Bigger jobs earned ${pct(b.margin)}.`,
          cause: "Small jobs carry the same trips, setup and admin as big ones, spread over less revenue.",
          action: `Set a minimum price, or add a trip or small-job charge. These jobs cost ${money(avgCost)} on average, so at ${s.targetText} one needs to sell for about ${money(avgNeeded)}.`,
          method: `${METHOD_PRICED} Small jobs are the smallest third or so of the jobs finished in the last 12 months, by revenue.`,
          jobIds: small.map((j) => j.f.jobId),
          href: null,
          breakdown: null,
          trackable: {
            kind: "small_jobs",
            subjectKey: String(threshold),
            costCategory: null,
            baselineMarginPct: s.margin,
            baselineJobs: s.n,
            baselineRevenue: s.revenue,
            targetMarginPct: s.uniformTarget != null ? s.uniformTarget * 100 : null,
          },
        });
      }
    }
  }

  // ---- Customers -----------------------------------------------------------
  if (!input.jobsAreCustomers) {
    const byCustomer = new Map<string, BasisJob[]>();
    for (const j of judged) {
      const c = j.f.customerName?.trim();
      if (c) byCustomer.set(c, [...(byCustomer.get(c) ?? []), j]);
    }
    for (const [customer, group] of byCustomer) {
      if (group.length < MIN_JOBS || group.length === judged.length) continue;
      const s = groupStats(group);
      if (!worthAnItem(s) || s.priceIncrease! < 0.02) continue;
      const { confidence, reason } = groupConfidence(s, `finished job for ${customer}`, `finished jobs for ${customer}`);
      items.push({
        id: `customer_pricing:${customer}`,
        kind: "customer_pricing",
        section: "pricing",
        title: `Work for ${customer} runs below ${s.targetText}`,
        impact: s.gapToTarget,
        impactLabel: "more profit a year",
        impactKind: "profit",
        confidence,
        confidenceReason: reason,
        finding: `${plural(s.n, "finished job")} for ${customer} earned ${pct(s.margin)} on ${money(s.revenue)}, against ${s.targetText}.`,
        cause: null,
        action: `Price ${possessive(customer)} next job about ${upPct(s.priceIncrease!)} higher, or talk to them about terms. If they won't move, decide whether the volume is worth it.`,
        method: `${METHOD_PRICED} Jobs finished in the last 12 months, grouped by QuickBooks customer.`,
        jobIds: group.map((j) => j.f.jobId),
        href: null,
        breakdown: null,
        trackable: {
          kind: "customer",
          subjectKey: customer,
          costCategory: null,
          baselineMarginPct: s.margin,
          baselineJobs: s.n,
          baselineRevenue: s.revenue,
          targetMarginPct: s.uniformTarget != null ? s.uniformTarget * 100 : null,
        },
      });
    }
  }

  // ---- Estimates that run low, when job types aren't set -----------------
  if (!typesCoverMost) {
    const withEstimate = basis.filter((j) => j.f.varianceVsEstimatePct != null && j.f.varianceVsEstimate != null && !input.targetFilledEstimates?.has(j.f.jobId));
    if (withEstimate.length >= MIN_JOBS) {
      const avgOver = withEstimate.reduce((t, j) => t + j.f.varianceVsEstimatePct!, 0) / withEstimate.length;
      const over = withEstimate.filter((j) => j.f.varianceVsEstimate! > 0);
      const total = over.reduce((t, j) => t + j.f.varianceVsEstimate!, 0);
      if (avgOver > 0.1 && total > 0) {
        items.push({
          id: "estimate_overrun",
          kind: "estimate_overrun",
          section: "pricing",
          title: `Your cost estimates come in about ${pct(avgOver, 0)} low`,
          impact: total,
          impactLabel: "over estimate, last 12 months",
          impactKind: "profit",
          confidence: withEstimate.length >= 6 && over.length / withEstimate.length >= 2 / 3 ? "high" : "medium",
          confidenceReason: `Based on ${plural(withEstimate.length, "finished job")} with a cost estimate, ${over.length} of them over it.`,
          finding: `${plural(over.length, "job")} of ${withEstimate.length} finished over their cost estimate, by ${money(total)} in all.`,
          cause: null,
          action: `Add about ${upPct(avgOver)} to the cost side of your estimates until you find where it goes. Setting job types shows which kind of work it comes from.`,
          method: "Actual cost minus estimated cost on finished jobs with a cost estimate entered by you or imported, over the last 12 months. Estimates filled in from your target margin are left out.",
          jobIds: over.map((j) => j.f.jobId),
          href: null,
          breakdown: null,
          trackable: null,
        });
      }
    }
  }

  // ---- Act now: open jobs -----------------------------------------------
  let openJobRisk = 0;
  const openAtRisk = new Set<string>();
  let unbilledWork = 0;
  for (const f of jobs) {
    if (f.status !== "open") continue;
    const target = targetFraction(f.targetMarginPct);
    const fc = forecasts.get(f.jobId);
    let forecastFlagged = false;
    if (
      target != null &&
      fc?.available &&
      fc.forecastMarginPct != null &&
      fc.forecastCostAtCompletion != null &&
      f.estimatedRevenue != null &&
      f.estimatedRevenue > 0 &&
      fc.forecastMarginPct < target - 0.01
    ) {
      const impact = f.estimatedRevenue * (target - fc.forecastMarginPct);
      forecastFlagged = true;
      openJobRisk += impact;
      openAtRisk.add(f.jobId);
      const overEstimate =
        f.estimatedCost != null && fc.forecastCostAtCompletion > f.estimatedCost * 1.02
          ? ` That's ${money(fc.forecastCostAtCompletion - f.estimatedCost)} more than the ${money(f.estimatedCost)} estimate.`
          : "";
      items.push({
        id: `open_job_forecast:${f.jobId}`,
        kind: "open_job_forecast",
        section: "act_now",
        title: `${f.jobName} is on track for ${pct(fc.forecastMarginPct)}, below your ${fmtTarget(target)} target`,
        impact,
        impactLabel: "short of target on this job",
        impactKind: "profit",
        confidence: fc.confidence ?? "low",
        confidenceReason: fc.method ?? "Forecast from cost to date.",
        finding: `On a ${money(f.estimatedRevenue)} contract, costs are heading for ${money(fc.forecastCostAtCompletion)}.${overEstimate}`,
        cause: null,
        action:
          "Check what's left to do against what's left in the budget, and write up anything outside the original scope as a change order before the work is done, not after.",
        method: "Target margin minus forecast margin, times the contract value. The forecast is on the job page.",
        jobIds: [f.jobId],
        href: `/dashboard/jobs/${f.jobId}`,
        breakdown: null,
        trackable: null,
      });
    }
    if (
      !forecastFlagged &&
      f.varianceVsEstimatePct != null &&
      f.varianceVsEstimate != null &&
      f.estimatedCost != null &&
      f.varianceVsEstimatePct > 0.1 &&
      !input.targetFilledEstimates?.has(f.jobId)
    ) {
      openJobRisk += f.varianceVsEstimate;
      openAtRisk.add(f.jobId);
      items.push({
        id: `open_job_over_estimate:${f.jobId}`,
        kind: "open_job_over_estimate",
        section: "act_now",
        title: `${f.jobName} has spent ${pct(f.varianceVsEstimatePct, 0)} more than its estimate`,
        impact: f.varianceVsEstimate,
        impactLabel: "over estimate so far",
        impactKind: "profit",
        confidence: "high",
        confidenceReason: "Actual costs synced from QuickBooks against the estimate on file.",
        finding: `${money(f.costs)} spent against a ${money(f.estimatedCost)} estimate, and the job is still open.`,
        cause: null,
        action: "Find the extra before the job closes: work outside the contract is a change order; a cost on the wrong job is a fix in QuickBooks.",
        method: "Cost to date minus the estimated cost.",
        jobIds: [f.jobId],
        href: `/dashboard/jobs/${f.jobId}`,
        breakdown: null,
        trackable: null,
      });
    }
    if (f.wip && f.estimatedRevenue != null && !f.wip.costPastEstimate) {
      const under = -f.wip.overUnderBilling;
      if (under > 1000 && under > f.estimatedRevenue * 0.05) {
        unbilledWork += under;
        items.push({
          id: `underbilled:${f.jobId}`,
          kind: "underbilled",
          section: "act_now",
          title: `${f.jobName}: ${money(under)} of finished work isn't billed`,
          impact: under,
          impactLabel: "to bill",
          impactKind: "cash",
          confidence: f.wip.percentCompleteSource === "manual" ? "high" : "medium",
          confidenceReason:
            f.wip.percentCompleteSource === "manual"
              ? "From your own percent complete."
              : "Percent complete estimated from cost to date against the estimate. Entering your own makes it exact.",
          finding: `About ${Math.round(f.wip.percentComplete * 100)}% complete, and ${money(f.revenue)} billed of a ${money(f.estimatedRevenue)} contract.`,
          cause: null,
          action: "Send the next progress bill. This is your money, already spent on the job.",
          method: "Contract value times percent complete, minus what's been billed. The same figure as the WIP report.",
          jobIds: [f.jobId],
          href: `/dashboard/jobs/${f.jobId}`,
          breakdown: null,
          trackable: null,
        });
      }
    }
  }

  // ---- Act now: estimates -----------------------------------------------
  let estimatesShortfall = 0;
  for (const e of input.estimateFlags) {
    estimatesShortfall += e.shortfall;
    items.push({
      id: `estimate_below_target:${e.estimateId}`,
      kind: "estimate_below_target",
      section: "act_now",
      title: `${e.label} looks ${e.shortfall >= 1 ? money(e.shortfall) : "slightly"} light${e.notEmailed ? ", and QuickBooks hasn't emailed it yet" : ""}`,
      impact: e.shortfall,
      impactLabel: e.notEmailed ? "before you send it" : "on this estimate",
      impactKind: "profit",
      confidence: e.confidence,
      confidenceReason: e.confidenceReason,
      finding: `If it goes like your last ${plural(e.historyJobs, `${typePhrase(e.typeLabel)} job`)}, it earns ${pct(e.predictedMarginPct)} against your ${fmtTarget(e.targetMarginPct)} target.`,
      cause: null,
      action: "Open the Estimate Check for the price that reaches your target, part by part, then update the estimate in QuickBooks.",
      method: "What similar finished jobs actually cost for each dollar charged, applied to this estimate's prices. The Estimate Check page shows the working.",
      jobIds: [],
      href: `/dashboard/estimates#estimate-${e.estimateId}`,
      breakdown: null,
      trackable: null,
    });
  }

  // ---- Setup hints -------------------------------------------------------
  if (!targetSet) {
    const tooHigh = jobs.some((f) => f.targetMarginPct != null && f.targetMarginPct > MAX_TARGET_PCT);
    setup.push({
      code: "no_target",
      message: tooHigh
        ? `Your target margin is set above ${MAX_TARGET_PCT}%, which no job can reach, so it's ignored. Set a realistic one and every figure here switches on.`
        : "Set a target margin. Every dollar figure here is measured against it, so without one most of this page stays empty.",
      href: "/dashboard/settings",
      linkText: "Set your target",
    });
  }
  const finishedUntyped = basis.filter((j) => !j.f.category).length;
  if (finishedUntyped > 0 && basis.length >= MIN_JOBS) {
    setup.push({
      code: "untyped_jobs",
      message: `${plural(finishedUntyped, "finished job has", "finished jobs have")} no job type, so ${finishedUntyped === 1 ? "it's" : "they're"} left out of the job-type comparisons. We can suggest types for you to check.`,
      href: "/dashboard/jobs#job-types",
      linkText: "Review suggested job types",
    });
  }
  const splitCount = usableSplits(basis.filter((j) => mixes.has(j.f.jobId)).map((j) => ({ f: j.f, mix: mixes.get(j.f.jobId)! }))).length;
  if (basis.length >= MIN_JOBS && splitCount < MIN_JOBS) {
    setup.push({
      code: "no_estimate_split",
      message:
        "Your QuickBooks estimates don't split the price into labor, materials and subs in a way that lines up with your costs, so we can't tell which part of a price is thin. Put labor, materials and subcontracted work on separate lines, each using its own product or service, and this switches on.",
      href: "/dashboard/settings#cost-categories",
      linkText: "See how lines are sorted",
    });
  }
  if ((input.idleOpenJobs ?? 0) > 0) {
    setup.push({
      code: "idle_open_jobs",
      message: `${plural(input.idleOpenJobs!, "open job has", "open jobs have")} had no activity in 90 days. Finished jobs only count here once they're marked completed.`,
      href: "/dashboard/data-health",
      linkText: "Mark them completed",
    });
  }
  if (basis.length < MIN_JOBS) {
    setup.push({
      code: "no_finished_jobs",
      message: `Pricing patterns come from finished jobs with revenue and costs in the last 12 months. You have ${basis.length}; they start at ${MIN_JOBS}.`,
      href: "/dashboard/jobs?status=open",
      linkText: "Mark finished jobs completed",
    });
  }

  // A customer whose jobs are exactly one job type's jobs says the same
  // thing twice; the customer is the more useful way to say it.
  const customerSets = new Set(items.filter((i) => i.kind === "customer_pricing").map((i) => [...i.jobIds].sort().join(",")));
  const deduped = items.filter((i) => !(i.kind === "job_type_pricing" && customerSets.has([...i.jobIds].sort().join(","))));

  // Act now: estimates first (still changeable for the price of an edit),
  // then open jobs, then bills to send. Everything else by dollars.
  const order: Record<FeedSection, number> = { act_now: 0, pricing: 1, working: 2 };
  const urgency: Partial<Record<FeedItemKind, number>> = {
    estimate_below_target: 0,
    open_job_forecast: 1,
    open_job_over_estimate: 1,
    underbilled: 2,
  };
  deduped.sort(
    (a, b) =>
      order[a.section] - order[b.section] || (urgency[a.kind] ?? 0) - (urgency[b.kind] ?? 0) || (b.impact ?? -1) - (a.impact ?? -1)
  );

  return {
    summary: {
      targetSet,
      pricingGap,
      jobsBelowTarget,
      jobsJudged: judged.length,
      openJobRisk,
      openJobsAtRisk: openAtRisk.size,
      estimatesShortfall,
      estimatesFlagged: input.estimateFlags.length,
      unbilledWork,
    },
    items: deduped,
    setup,
    finishedJobsConsidered: basis.length,
  };
}

// ---------------------------------------------------------------------------
// Estimate Check
// ---------------------------------------------------------------------------

export interface EstimateCheckInput {
  amount: number;
  lines: EstimateLine[];
  /** Target for this estimate's job type, percent. */
  targetPct: number | null;
  /** Finished jobs of the same type (any age; the window is applied here). */
  history: { f: JobFinancials; mix: PricedMix | null }[];
  now: Date;
}

export interface EstimateCategoryCheck {
  category: CoreCategory;
  charged: number;
  /** What similar jobs spent per dollar charged for this part. */
  costRatio: number;
  expectedCost: number;
  /** The price for this part that reaches the target. */
  priceAtTarget: number;
}

export type EstimateCheckStatus = "below_target" | "on_target" | "no_history" | "no_target" | "no_amount";

export interface EstimateCheckResult {
  status: EstimateCheckStatus;
  historyJobs: number;
  historyWithSplit: number;
  method: "by_part" | "whole_job" | null;
  expectedCost: number | null;
  expectedMarginPct: number | null;
  targetMarginPct: number | null;
  priceAtTarget: number | null;
  shortfall: number | null;
  parts: EstimateCategoryCheck[];
  confidence: "high" | "medium" | "low";
  confidenceReason: string;
  /** Plain explanation of the result. */
  summary: string;
}

/**
 * What a pending estimate is likely to earn, judged by what the company's
 * own finished jobs of the same type actually cost for every dollar charged.
 *
 * Part by part when it's safe: past jobs whose split lines up with their
 * costs, and an estimate that prices every part those jobs spent real money
 * on. An estimate that prices labor thinner than usual is then caught even
 * when its total looks normal. Otherwise the whole price is costed at the
 * past jobs' overall rate, which can't miss cost the estimate didn't list.
 */
export function computeEstimateCheck(input: EstimateCheckInput): EstimateCheckResult {
  const since = input.now.getTime() - HISTORY_WINDOW_DAYS * DAY;
  const history = input.history.filter(
    (h) =>
      h.f.status === "closed" &&
      h.f.profitabilityAvailable &&
      h.f.revenue > 0 &&
      h.f.costs > 0 &&
      h.f.lastFinancialActivity != null &&
      h.f.lastFinancialActivity.getTime() >= since
  );
  const target = targetFraction(input.targetPct);
  const withSplit = usableSplits(history.filter((h) => h.mix).map((h) => ({ f: h.f, mix: h.mix! })));
  const base = { historyJobs: history.length, historyWithSplit: withSplit.length, parts: [] as EstimateCategoryCheck[] };
  const empty = (status: EstimateCheckStatus, summary: string): EstimateCheckResult => ({
    ...base,
    status,
    method: null,
    expectedCost: null,
    expectedMarginPct: null,
    targetMarginPct: target,
    priceAtTarget: null,
    shortfall: null,
    confidence: "low",
    confidenceReason: summary,
    summary,
  });
  if (input.amount <= 0) return empty("no_amount", "This estimate has no amount to check.");
  if (target == null) return empty("no_target", "Set a target margin (in Settings) to check estimates against it.");
  if (history.length < MIN_JOBS) {
    return empty(
      "no_history",
      `Checking needs at least ${MIN_JOBS} finished jobs of this type from the last two years with revenue and costs. There ${history.length === 1 ? "is" : "are"} ${history.length}.`
    );
  }

  const revenue = history.reduce((s, h) => s + h.f.revenue, 0);
  const cost = history.reduce((s, h) => s + h.f.costs, 0);
  const wholeRatio = cost / revenue;

  const mix = pricedMixFromLines(input.lines);
  const results = withSplit.length >= MIN_JOBS ? categoryResults(withSplit) : [];
  // Every part the past jobs spent real money on must be priced on this
  // estimate, or its cost would be left out of the prediction.
  const historyCost = results.reduce((s, r) => s + r.cost, 0);
  const unpriced = mix
    ? results.filter((r) => historyCost > 0 && r.cost / historyCost >= 0.05 && !(mix.shares[r.category] ?? 0))
    : [];
  let expectedCost: number;
  let method: "by_part" | "whole_job";
  let methodNote = "";
  const parts: EstimateCategoryCheck[] = [];
  if (mix && results.length > 0 && unpriced.length === 0) {
    method = "by_part";
    const byCat = new Map(results.map((r) => [r.category, r]));
    expectedCost = 0;
    for (const k of CORE_CATEGORIES) {
      const share = mix.shares[k];
      if (!share) continue;
      const charged = share * input.amount;
      const r = byCat.get(k);
      // A part past jobs never priced separately is costed at the overall rate.
      const costRatio = r && r.charged > 0 ? r.cost / r.charged : wholeRatio;
      const partCost = charged * costRatio;
      expectedCost += partCost;
      parts.push({ category: k, charged, costRatio, expectedCost: partCost, priceAtTarget: partCost / (1 - target) });
    }
  } else {
    method = "whole_job";
    expectedCost = input.amount * wholeRatio;
    if (mix && unpriced.length > 0) {
      methodNote = ` Checked on the whole price, because this estimate doesn't price ${unpriced.map((u) => PART_NAMES[u.category]).join(" or ")} separately and your past jobs of this type spent money on it.`;
    }
  }

  const expectedMarginPct = 1 - expectedCost / input.amount;
  const priceAtTarget = expectedCost / (1 - target);
  const shortfall = Math.max(0, priceAtTarget - input.amount);

  // How much the past jobs agree with each other.
  const margins = history.map((h) => 1 - h.f.costs / h.f.revenue);
  const mean = margins.reduce((s, m) => s + m, 0) / margins.length;
  const spread = Math.sqrt(margins.reduce((s, m) => s + (m - mean) ** 2, 0) / margins.length);
  let confidence: "high" | "medium" | "low" = history.length >= 6 ? "high" : "medium";
  let confidenceReason = `Based on ${plural(history.length, "finished job")} of this type${method === "by_part" ? `, ${withSplit.length} with a split estimate` : ""}.${methodNote}`;
  if (spread > 0.15) {
    confidence = "low";
    confidenceReason += ` Their margins vary a lot (${pct(Math.min(...margins), 0)} to ${pct(Math.max(...margins), 0)}), so treat this as a rough guide.`;
  }

  // Below means below: the words never say "at or above" a target the
  // figure beside them misses, however small the dollar amount.
  const below = expectedMarginPct < target - 1e-9;
  return {
    ...base,
    parts,
    status: below ? "below_target" : "on_target",
    method,
    expectedCost,
    expectedMarginPct,
    targetMarginPct: target,
    priceAtTarget,
    shortfall: below ? shortfall : 0,
    confidence,
    confidenceReason,
    summary: below
      ? `If this job goes like your past ones, it costs about ${money(expectedCost)} and earns ${pct(expectedMarginPct)}. Reaching your ${fmtTarget(target)} target takes about ${money(priceAtTarget)}, ${money(shortfall)} more than quoted.`
      : `If this job goes like your past ones, it costs about ${money(expectedCost)} and earns ${pct(expectedMarginPct)}, at or above your ${fmtTarget(target)} target.`,
  };
}

// ---------------------------------------------------------------------------
// Outcome tracking
// ---------------------------------------------------------------------------

export interface TrackedAction {
  kind: TrackableChange["kind"];
  subjectKey: string;
  costCategory: CoreCategory | null;
  baselineMarginPct: number;
  baselineJobs: number;
  startedAt: Date;
}

export interface ActionOutcome {
  status: "waiting" | "measured";
  /** Finished jobs set up in QuickBooks after the change. */
  afterJobs: number;
  /** Open jobs set up after the change. */
  inProgress: number;
  afterMarginPct: number | null;
  /** Gross profit on the "after" jobs above what the baseline margin would have made. Can be negative. */
  extraProfit: number | null;
  confidence: "high" | "medium" | "low";
  message: string;
  jobIds: string[];
}

function matchesAction(a: TrackedAction, f: JobFinancials): boolean {
  switch (a.kind) {
    case "job_type":
      return f.category === a.subjectKey;
    case "customer":
      return (f.customerName ?? "").trim() === a.subjectKey;
    case "small_jobs": {
      // Judged on cost, because the change being measured raises the price:
      // a job that used to sell for $4,000 and now sells for $4,800 is still
      // one of the small jobs.
      const threshold = Number(a.subjectKey);
      const costCeiling = threshold * (1 - a.baselineMarginPct);
      return Number.isFinite(threshold) && f.costs > 0 && f.costs <= Math.max(costCeiling, threshold * 0.5);
    }
    case "cost_category":
      return true;
  }
}

/**
 * Before and after for a pricing change the contractor said they'd make.
 * "After" is jobs set up in QuickBooks after the change started, which is
 * the closest the books come to "priced under it". Their margin (or, for a
 * change to one part of the price, that part's margin) is set against the
 * baseline recorded when the change was tracked.
 */
export function computeActionOutcome(action: TrackedAction, jobs: JobFinancials[], mixes: Map<string, PricedMix>): ActionOutcome {
  const after = jobs.filter(
    (f) => f.qboCreatedAt != null && f.qboCreatedAt.getTime() >= action.startedAt.getTime() && matchesAction(action, f)
  );
  const finished = after.filter((f) => f.status === "closed" && f.profitabilityAvailable && f.revenue > 0 && f.costs > 0);
  const inProgress = after.filter((f) => f.status === "open").length;

  let measured: { margin: number; revenue: number; n: number; ids: string[] } | null = null;
  let unsplitFinished = 0;
  if (action.costCategory) {
    const all = finished.filter((f) => mixes.has(f.jobId)).map((f) => ({ f, mix: mixes.get(f.jobId)! }));
    const withMix = usableSplits(all);
    unsplitFinished = finished.length - withMix.length;
    const part = categoryResults(withMix).find((r) => r.category === action.costCategory);
    if (part && withMix.length > 0) measured = { margin: part.marginPct, revenue: part.charged, n: withMix.length, ids: withMix.map((w) => w.f.jobId) };
  } else if (finished.length > 0) {
    const revenue = finished.reduce((s, f) => s + f.revenue, 0);
    const cost = finished.reduce((s, f) => s + f.costs, 0);
    measured = { margin: 1 - cost / revenue, revenue, n: finished.length, ids: finished.map((f) => f.jobId) };
  }

  if (!measured) {
    const part = action.costCategory ? PART_NAMES[action.costCategory] : null;
    return {
      status: "waiting",
      afterJobs: unsplitFinished,
      inProgress,
      afterMarginPct: null,
      extraProfit: null,
      confidence: "low",
      message:
        unsplitFinished > 0 && part
          ? `${plural(unsplitFinished, "job")} set up since then ${unsplitFinished === 1 ? "has" : "have"} finished, but ${unsplitFinished === 1 ? "its estimate doesn't" : "their estimates don't"} split the price in a way that lines up with the costs, so the ${part} can't be measured on ${unsplitFinished === 1 ? "it" : "them"}.`
          : inProgress > 0
            ? `${plural(inProgress, "job")} set up since then ${inProgress === 1 ? "is" : "are"} still in progress. The result shows when the first one is marked completed.`
            : "No jobs of this kind have been set up in QuickBooks since then. The result shows once one is priced and finished.",
      jobIds: after.map((f) => f.jobId),
    };
  }

  const extraProfit = measured.revenue * (measured.margin - action.baselineMarginPct);
  const better = measured.margin > action.baselineMarginPct;
  return {
    status: "measured",
    afterJobs: measured.n,
    inProgress,
    afterMarginPct: measured.margin,
    extraProfit,
    confidence: measured.n >= 5 ? "high" : measured.n >= MIN_JOBS ? "medium" : "low",
    message: `${plural(measured.n, "finished job")} set up since then earned ${pct(measured.margin)}, against ${pct(action.baselineMarginPct)} before. ${
      better
        ? `That's ${money(extraProfit)} more gross profit than the old margin would have made.`
        : `That's ${money(-extraProfit)} less than the old margin would have made, so the change hasn't shown up yet.`
    }${measured.n < MIN_JOBS ? " Early days: one or two jobs can swing either way." : ""}`,
    jobIds: measured.ids,
  };
}

/** For the pages and the AI write-up: the part of the job as words. */
export function coreCategoryName(c: CostCategory | CoreCategory): string {
  return (PART_NAMES as Record<string, string>)[c] ?? c;
}
