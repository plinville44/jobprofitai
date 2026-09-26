// ============================================================================
// SAMPLE COMPANY
// ----------------------------------------------------------------------------
// An invented contractor, "Example Builders", run through the real engine
// (computeJobFinancials, computeOpportunityFeed, computeEstimateCheck,
// computeActionOutcome) so the marketing site and /demo show exactly what the
// product produces, wording and arithmetic included. Nothing here is a real
// customer's data, and every place it's shown is labelled "Example data".
//
// Pure and fixed: the same "today" every time, so the site never drifts.
// ============================================================================

import { computeJobFinancials, type FinancialContext, type JobFinancials, type JobInput } from "./profitability";
import {
  computeActionOutcome,
  computeEstimateCheck,
  computeOpportunityFeed,
  type ActionOutcome,
  type EstimateCheckResult,
  type EstimateFeedEntry,
  type OpportunityFeed,
  type PricedMix,
} from "./opportunities";
import type { EstimateLine } from "./qboNormalize";

export const SAMPLE_NOW = new Date("2026-09-01T12:00:00Z");
export const SAMPLE_TARGET_PCT = 28;

const TYPE_LABELS: Record<string, string> = {
  c_kitchen: "Kitchen remodel",
  c_bath: "Bathroom remodel",
  roofing: "Roofing",
  c_service: "Service call",
  general: "General Contracting",
  c_deck: "Deck",
  new_construction: "Addition",
};
export const sampleTypeLabel = (k: string) => TYPE_LABELS[k] ?? k;

const day = (iso: string) => new Date(`${iso}T00:00:00Z`);

interface SampleJob {
  id: string;
  name: string;
  customer: string;
  type: string;
  status: "open" | "closed";
  /** Invoiced so far. */
  revenue: number;
  /** Actual cost by category. */
  costs: Partial<Record<"labor" | "materials" | "subcontractor" | "equipment" | "other", number>>;
  contract?: number;
  estimatedCost?: number;
  created: string;
  lastActivity: string;
  /** How the price was split on the estimate. */
  mix?: PricedMix["shares"];
}

const KITCHEN_MIX = { labor: 0.4, materials: 0.4, subcontractor: 0.2 };
const BATH_MIX = { labor: 0.45, materials: 0.35, subcontractor: 0.2 };

/** A finished job whose parts cost the given share of what was charged for them. */
function finished(
  id: string,
  name: string,
  customer: string,
  type: string,
  revenue: number,
  mix: PricedMix["shares"],
  costRatio: Partial<Record<"labor" | "materials" | "subcontractor", number>>,
  created: string,
  lastActivity: string
): SampleJob {
  const costs: SampleJob["costs"] = {};
  for (const [k, share] of Object.entries(mix)) {
    const r = costRatio[k as keyof typeof costRatio] ?? 0.7;
    costs[k as "labor"] = Math.round(revenue * (share ?? 0) * r);
  }
  return { id, name, customer, type, status: "closed", revenue, costs, created, lastActivity, mix };
}

const KITCHEN_RATIO = { labor: 0.96, materials: 0.62, subcontractor: 0.8 };
const BATH_RATIO = { labor: 0.7, materials: 0.58, subcontractor: 0.66 };

export const SAMPLE_JOBS: SampleJob[] = [
  // Kitchen remodels: labor priced thin.
  finished("k1", "Maple St. Kitchen", "Hollis", "c_kitchen", 54_000, KITCHEN_MIX, KITCHEN_RATIO, "2025-08-04", "2025-11-14"),
  finished("k2", "Birch Ave Kitchen", "Park", "c_kitchen", 46_500, KITCHEN_MIX, KITCHEN_RATIO, "2025-09-10", "2025-12-19"),
  finished("k3", "Lakeview Kitchen", "Osei", "c_kitchen", 61_200, KITCHEN_MIX, { ...KITCHEN_RATIO, labor: 0.9 }, "2025-10-01", "2026-01-23"),
  finished("k4", "Hawthorne Kitchen", "Ruiz", "c_kitchen", 38_900, KITCHEN_MIX, KITCHEN_RATIO, "2025-11-12", "2026-02-27"),
  finished("k5", "Summit Rd Kitchen", "Baker", "c_kitchen", 49_800, KITCHEN_MIX, { ...KITCHEN_RATIO, labor: 1.02 }, "2026-01-05", "2026-04-10"),
  finished("k6", "Quarry Ln Kitchen", "Stein", "c_kitchen", 57_300, KITCHEN_MIX, KITCHEN_RATIO, "2026-02-02", "2026-05-15"),
  finished("k7", "Juniper Kitchen", "Adeyemi", "c_kitchen", 52_400, KITCHEN_MIX, KITCHEN_RATIO, "2026-05-11", "2026-08-07"),
  finished("k8", "Westgate Kitchen", "Morales", "c_kitchen", 47_100, KITCHEN_MIX, KITCHEN_RATIO, "2026-06-01", "2026-08-21"),
  // Bathroom remodels: the best work.
  finished("b1", "Oak Ave Bath", "Nguyen", "c_bath", 24_600, BATH_MIX, BATH_RATIO, "2025-09-15", "2025-10-30"),
  finished("b2", "Fern St. Bath", "Kowalski", "c_bath", 19_800, BATH_MIX, BATH_RATIO, "2025-11-03", "2025-12-12"),
  finished("b3", "Ridge Ct. Primary Bath", "Singh", "c_bath", 31_400, BATH_MIX, BATH_RATIO, "2026-01-20", "2026-03-06"),
  finished("b4", "Harbor Pt. Bath", "Dubois", "c_bath", 22_900, BATH_MIX, BATH_RATIO, "2026-03-09", "2026-04-24"),
  finished("b5", "Linden Bath", "Cho", "c_bath", 27_300, BATH_MIX, BATH_RATIO, "2026-05-04", "2026-06-19"),
  finished("b6", "Aspen Ct. Bath", "Walsh", "c_bath", 21_700, BATH_MIX, BATH_RATIO, "2026-06-15", "2026-07-31"),
  // Roofing before the price change: finished more than a year ago, so
  // they're the tracked change's "before" and outside the feed's window.
  ...[
    ["r0a", "Sutton Reroof", 17_800, "2024-11-04", "2025-01-17"],
    ["r0b", "Holt Rd Roof", 21_300, "2025-01-13", "2025-03-28"],
    ["r0c", "Crane Ave Roof", 19_600, "2025-03-10", "2025-05-23"],
    ["r0d", "Lark St. Reroof", 23_900, "2025-05-19", "2025-08-08"],
  ].map(([id, name, rev, created, last]) => ({
    id: id as string,
    name: name as string,
    customer: `${(name as string).split(" ")[0]} Homeowner`,
    type: "roofing",
    status: "closed" as const,
    revenue: rev as number,
    costs: { materials: Math.round((rev as number) * 0.45), labor: Math.round((rev as number) * 0.34) },
    created: created as string,
    lastActivity: last as string,
  })),
  // Roofing priced since the change (tracked from 2025-10-01): on target.
  ...[
    ["r1", "Elm Ct. Reroof", 18_400, "2025-10-06", "2025-11-20"],
    ["r2", "Pinecrest Reroof", 22_100, "2025-11-03", "2025-12-05"],
    ["r3", "Mill Rd Roof", 16_900, "2026-02-16", "2026-03-20"],
    ["r4", "Bayside Roof", 25_300, "2026-04-20", "2026-05-29"],
    ["r5", "Knoll Ave Roof", 19_700, "2026-06-08", "2026-07-10"],
  ].map(([id, name, rev, created, last]) => ({
    id: id as string,
    name: name as string,
    customer: `${(name as string).split(" ")[0]} Homeowner`,
    type: "roofing",
    status: "closed" as const,
    revenue: rev as number,
    costs: { materials: Math.round((rev as number) * 0.4), labor: Math.round((rev as number) * 0.31) },
    created: created as string,
    lastActivity: last as string,
  })),
  // A builder they sub for, at a thin margin.
  ...[
    ["g1", "Brightline Lot 14", 34_800, "2025-11-21"],
    ["g2", "Brightline Lot 17", 29_600, "2026-02-13"],
    ["g3", "Brightline Lot 22", 37_200, "2026-06-05"],
  ].map(([id, name, rev, last]) => ({
    id: id as string,
    name: name as string,
    customer: "Brightline Builders",
    type: "general",
    status: "closed" as const,
    revenue: rev as number,
    costs: { subcontractor: Math.round((rev as number) * 0.5), labor: Math.round((rev as number) * 0.35) },
    created: "2025-09-01",
    lastActivity: last as string,
  })),
  // Service calls: small, and they don't pay.
  ...[
    ["s1", "Wexford leak repair", 1_850, "2025-10-08"],
    ["s2", "Tamarack door fix", 2_400, "2025-12-17"],
    ["s3", "Dover St. fascia repair", 3_100, "2026-02-04"],
    ["s4", "Glen Rd gutter repair", 2_750, "2026-04-15"],
    ["s5", "Cove Ln drywall patch", 3_600, "2026-06-24"],
  ].map(([id, name, rev, last]) => ({
    id: id as string,
    name: name as string,
    customer: `${(name as string).split(" ")[0]} Homeowner`,
    type: "c_service",
    status: "closed" as const,
    revenue: rev as number,
    costs: { labor: Math.round((rev as number) * 0.62), materials: Math.round((rev as number) * 0.3) },
    created: "2025-09-01",
    lastActivity: last as string,
  })),
  // Open jobs.
  {
    id: "o1",
    name: "Harborview Roof Replacement",
    customer: "Harborview HOA",
    type: "roofing",
    status: "open",
    revenue: 100_000,
    costs: { materials: 49_700, labor: 33_100 },
    contract: 128_000,
    estimatedCost: 72_600,
    created: "2026-06-02",
    lastActivity: "2026-08-28",
  },
  {
    id: "o2",
    name: "Cedar Ln. Deck Rebuild",
    customer: "Fraser",
    type: "c_deck",
    status: "open",
    revenue: 64_000,
    costs: { materials: 27_300, labor: 25_000 },
    contract: 90_000,
    estimatedCost: 64_000,
    created: "2026-06-20",
    lastActivity: "2026-08-26",
  },
  {
    id: "o3",
    name: "Pine Ridge Addition",
    customer: "Lindqvist",
    type: "new_construction",
    status: "open",
    revenue: 142_000,
    costs: { materials: 41_000, subcontractor: 22_500, labor: 35_200 },
    contract: 180_000,
    estimatedCost: 124_000,
    created: "2026-05-18",
    lastActivity: "2026-08-29",
  },
];

export interface SampleEstimate {
  id: string;
  docNumber: string;
  customerName: string;
  type: string;
  amount: number;
  notEmailed: boolean;
  lines: EstimateLine[];
}

export const SAMPLE_ESTIMATES: SampleEstimate[] = [
  {
    id: "e1043",
    docNumber: "1043",
    customerName: "Alvarez",
    type: "c_kitchen",
    amount: 43_000,
    notEmailed: true,
    lines: [
      { n: "Kitchen labor", c: "labor", a: 16_000 },
      { n: "Cabinets and counters", c: "materials", a: 19_000 },
      { n: "Electrical and plumbing (subcontracted)", c: "subcontractor", a: 8_000 },
    ],
  },
  {
    id: "e1045",
    docNumber: "1045",
    customerName: "Nguyen",
    type: "c_bath",
    amount: 26_500,
    notEmailed: false,
    lines: [
      { n: "Bath labor", c: "labor", a: 12_000 },
      { n: "Tile and fixtures", c: "materials", a: 9_300 },
      { n: "Plumbing (subcontracted)", c: "subcontractor", a: 5_200 },
    ],
  },
];

export const SAMPLE_TRACKED = {
  kind: "job_type" as const,
  subjectKey: "roofing",
  costCategory: null,
  startedAt: day("2025-10-01"),
  action: "Raise prices on roofing jobs by about 10%. On the same work, that reaches your 28% target.",
};

export interface SampleCompany {
  jobs: JobFinancials[];
  feed: OpportunityFeed;
  estimates: (SampleEstimate & { check: EstimateCheckResult; typeLabel: string })[];
  tracked: { action: string; subjectLabel: string; baselineMarginPct: number; baselineJobs: number; startedAt: Date; outcome: ActionOutcome };
  jobNames: Record<string, string>;
}

let cached: SampleCompany | null = null;

/** The sample company, computed once per server. */
export function getSampleCompany(): SampleCompany {
  if (cached) return cached;
  const ctx: FinancialContext = {
    now: SAMPLE_NOW,
    targetMarginPct: SAMPLE_TARGET_PCT,
    categoryTargetMarginPct: {},
    overheadEnabled: false,
    overheadMethod: null,
    overheadValue: null,
    lastSyncedAt: SAMPLE_NOW,
  };
  const inputs: JobInput[] = SAMPLE_JOBS.map((j) => ({
    id: j.id,
    name: j.name,
    customerName: j.customer,
    status: j.status,
    category: j.type,
    estimatedRevenue: j.contract ?? null,
    estimatedCost: j.estimatedCost ?? null,
    qboCreatedAt: day(j.created),
    startDate: null,
    endDate: null,
    updatedAt: day(j.lastActivity),
    costEntries: Object.entries(j.costs).map(([category, amount]) => ({ category, amount: amount ?? 0, txnDate: day(j.lastActivity) })),
    invoices: [{ amount: j.revenue, status: "paid", txnDate: day(j.lastActivity) }],
  }));
  const jobs = inputs.map((i) => computeJobFinancials(i, ctx));
  const mixes = new Map<string, PricedMix>(
    SAMPLE_JOBS.filter((j) => j.mix).map((j) => [j.id, { shares: j.mix!, coverage: 1, quoted: j.revenue }])
  );

  const estimates = SAMPLE_ESTIMATES.map((e) => {
    const history = jobs.filter((f) => f.category === e.type).map((f) => ({ f, mix: mixes.get(f.jobId) ?? null }));
    const check = computeEstimateCheck({ amount: e.amount, lines: e.lines, targetPct: SAMPLE_TARGET_PCT, history, now: SAMPLE_NOW });
    return { ...e, check, typeLabel: sampleTypeLabel(e.type) };
  });
  const estimateFlags: EstimateFeedEntry[] = estimates
    .filter((e) => e.check.status === "below_target")
    .map((e) => ({
      estimateId: e.id,
      label: `Estimate ${e.docNumber} for ${e.customerName}`,
      shortfall: e.check.shortfall ?? 0,
      predictedMarginPct: e.check.expectedMarginPct ?? 0,
      targetMarginPct: e.check.targetMarginPct ?? 0,
      confidence: e.check.confidence,
      confidenceReason: e.check.confidenceReason,
      notEmailed: e.notEmailed,
      typeLabel: e.typeLabel,
      historyJobs: e.check.historyJobs,
    }));

  const feed = computeOpportunityFeed({
    now: SAMPLE_NOW,
    jobs,
    forecasts: new Map(),
    mixes,
    typeLabel: sampleTypeLabel,
    estimateFlags,
  });

  // The tracked change's baseline: the roofs set up before it started, as
  // the feed would have shown them then.
  const before = jobs.filter((f) => f.category === SAMPLE_TRACKED.subjectKey && (f.qboCreatedAt?.getTime() ?? 0) < SAMPLE_TRACKED.startedAt.getTime());
  const baselineMarginPct = 1 - before.reduce((s, f) => s + f.costs, 0) / before.reduce((s, f) => s + f.revenue, 0);
  const outcome = computeActionOutcome(
    { ...SAMPLE_TRACKED, baselineMarginPct, baselineJobs: before.length },
    jobs,
    mixes
  );

  cached = {
    jobs,
    feed,
    estimates,
    tracked: {
      action: SAMPLE_TRACKED.action,
      subjectLabel: sampleTypeLabel(SAMPLE_TRACKED.subjectKey),
      baselineMarginPct,
      baselineJobs: before.length,
      startedAt: SAMPLE_TRACKED.startedAt,
      outcome,
    },
    jobNames: Object.fromEntries(jobs.map((j) => [j.jobId, j.jobName])),
  };
  return cached;
}
