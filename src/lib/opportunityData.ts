import { prisma } from "./prisma";
import { getConnectionProfitData, type ConnectionProfitData, type JobFinancials } from "./profitability";
import { getJobTypes } from "./jobTypesServer";
import { labelForJobType, suggestJobType, suggestJobTypeFromEstimateLines, type CompanyJobType } from "./jobTypes";
import { buildJobIndex, resolveJob, type EstimateLine } from "./qboNormalize";
import {
  computeActionOutcome,
  computeEstimateCheck,
  computeOpportunityFeed,
  pricedMixForJob,
  type ActionOutcome,
  type CoreCategory,
  type EstimateCheckResult,
  type EstimateFeedEntry,
  type OpportunityFeed,
  type PricedMix,
} from "./opportunities";

/** Pending estimates older than this aren't checked: they're dead or long since sent. */
const PENDING_ESTIMATE_DAYS = 180;

const asLines = (v: unknown): EstimateLine[] | null =>
  Array.isArray(v) ? (v as EstimateLine[]).filter((l) => l && typeof l.a === "number" && typeof l.c === "string") : null;

export interface CheckedEstimate {
  id: string;
  qboEstimateId: string;
  docNumber: string | null;
  customerName: string | null;
  amount: number;
  txnDate: Date;
  expirationDate: Date | null;
  emailStatus: string | null;
  notEmailed: boolean;
  lines: EstimateLine[];
  jobId: string | null;
  jobName: string | null;
  /** The job type used, and where it came from. */
  typeKey: string | null;
  typeSource: "job" | "chosen" | "suggested" | null;
  typeReason: string | null;
  typeLabel: string;
  targetPct: number | null;
  check: EstimateCheckResult;
}

export interface OpportunityData {
  feed: OpportunityFeed;
  estimates: CheckedEstimate[];
  jobTypes: CompanyJobType[];
  mixes: Map<string, PricedMix>;
  jobs: JobFinancials[];
  profitData: ConnectionProfitData;
}

/**
 * Everything the Profit Opportunity Feed, the Estimate Check and outcome
 * tracking need, from local data only (no QuickBooks call). Whole-life job
 * figures across every job, whatever the dashboard's tab or period.
 */
export async function getOpportunityData(connectionId: string, now: Date = new Date()): Promise<OpportunityData> {
  const [profitData, jobTypes, connection, jobRows, estimateRows] = await Promise.all([
    getConnectionProfitData(connectionId, now),
    getJobTypes(connectionId),
    prisma.quickBooksConnection.findUniqueOrThrow({
      where: { id: connectionId },
      select: { jobSource: true, targetMarginPct: true, marginTargets: { select: { category: true, targetPct: true } } },
    }),
    prisma.job.findMany({
      where: { connectionId },
      select: { id: true, qboId: true, parentQboId: true, name: true, category: true, estimatedCostSource: true, missingSince: true },
    }),
    prisma.jobEstimate.findMany({ where: { connectionId } }),
  ]);

  const jobs = profitData.lifetimeJobs;
  const typeLabel = (key: string) => labelForJobType(jobTypes, key);

  // Estimates onto jobs, by the same rule the sync uses for contract value.
  const index = buildJobIndex(jobRows);
  const estimatesByJob = new Map<string, typeof estimateRows>();
  for (const e of estimateRows) {
    const r = resolveJob(index, e.customerQboId);
    if (r) estimatesByJob.set(r.jobId, [...(estimatesByJob.get(r.jobId) ?? []), e]);
  }
  const mixes = new Map<string, PricedMix>();
  for (const [jobId, list] of estimatesByJob) {
    const mix = pricedMixForJob(
      list.map((e) => ({ amount: Number(e.amount), status: e.status, txnDate: e.txnDate, lines: asLines(e.lines) }))
    );
    if (mix) mixes.set(jobId, mix);
  }
  const targetFilledEstimates = new Set(jobRows.filter((j) => j.estimatedCostSource === "target_margin").map((j) => j.id));

  // Targets by job type, for estimates that aren't on a job yet.
  const companyTarget = connection.targetMarginPct == null ? null : Number(connection.targetMarginPct);
  const typeTargets = new Map(connection.marginTargets.map((t) => [t.category, Number(t.targetPct)]));
  const targetFor = (type: string | null) => (type && typeTargets.has(type) ? typeTargets.get(type)! : companyTarget);

  const jobById = new Map(jobRows.map((j) => [j.id, j]));
  const finishedByType = new Map<string, JobFinancials[]>();
  for (const f of jobs) if (f.category && f.status === "closed") finishedByType.set(f.category, [...(finishedByType.get(f.category) ?? []), f]);

  const since = now.getTime() - PENDING_ESTIMATE_DAYS * 86_400_000;
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const estimates: CheckedEstimate[] = [];
  for (const e of estimateRows) {
    if (e.status.toLowerCase() !== "pending") continue;
    if (e.txnDate.getTime() < since) continue;
    if (e.expirationDate && e.expirationDate.getTime() < today) continue;
    const lines = asLines(e.lines) ?? [];
    // Only a direct match counts as "this estimate is for that job". A new
    // estimate on a returning customer's name is new work, not their old job.
    const direct = index.byQboId.get(e.customerQboId) ?? null;
    const job = direct ? jobById.get(direct) ?? null : null;
    let typeKey: string | null = null;
    let typeSource: CheckedEstimate["typeSource"] = null;
    let typeReason: string | null = null;
    if (job?.category) {
      typeKey = job.category;
      typeSource = "job";
    } else if (e.jobType && jobTypes.some((t) => t.value === e.jobType)) {
      typeKey = e.jobType;
      typeSource = "chosen";
    } else {
      const s =
        suggestJobType(e.customerName, jobTypes) ??
        suggestJobTypeFromEstimateLines(lines.map((l) => ({ name: l.n, amount: l.a })), jobTypes);
      if (s) {
        typeKey = s.value;
        typeSource = "suggested";
        typeReason = s.source === "estimate" ? `The estimate's lines mention "${s.matchedOn}".` : `The name mentions "${s.matchedOn}".`;
      }
    }
    const targetPct = targetFor(typeKey);
    const history = typeKey
      ? (finishedByType.get(typeKey) ?? []).filter((f) => f.jobId !== job?.id).map((f) => ({ f, mix: mixes.get(f.jobId) ?? null }))
      : [];
    const check = typeKey
      ? computeEstimateCheck({ amount: Number(e.amount), lines, targetPct, history, now })
      : {
          ...computeEstimateCheck({ amount: Number(e.amount), lines, targetPct, history: [], now }),
          summary: "Choose a job type so this estimate can be compared with your finished jobs of that type.",
        };
    // QuickBooks only knows whether IT emailed the estimate; one printed or
    // sent as a PDF still reads as not emailed, and the wording says so.
    const notEmailed = e.emailStatus !== "EmailSent";
    estimates.push({
      id: e.id,
      qboEstimateId: e.qboEstimateId,
      docNumber: e.docNumber,
      customerName: e.customerName,
      amount: Number(e.amount),
      txnDate: e.txnDate,
      expirationDate: e.expirationDate,
      emailStatus: e.emailStatus,
      notEmailed,
      lines,
      jobId: job?.id ?? null,
      jobName: job?.name ?? null,
      typeKey,
      typeSource,
      typeReason,
      typeLabel: typeKey ? typeLabel(typeKey) : "No job type",
      targetPct,
      check,
    });
  }
  estimates.sort(
    (a, b) =>
      Number(b.check.status === "below_target") - Number(a.check.status === "below_target") ||
      Number(b.notEmailed) - Number(a.notEmailed) ||
      (b.check.shortfall ?? 0) - (a.check.shortfall ?? 0) ||
      b.txnDate.getTime() - a.txnDate.getTime()
  );

  const estimateFlags: EstimateFeedEntry[] = estimates
    // Every estimate the check calls below target, so the feed and the
    // Estimate Check page always agree on how many there are.
    .filter((e) => e.check.status === "below_target")
    .map((e) => ({
      estimateId: e.id,
      label: estimateLabel(e),
      shortfall: e.check.shortfall ?? 0,
      predictedMarginPct: e.check.expectedMarginPct ?? 0,
      targetMarginPct: e.check.targetMarginPct ?? 0,
      // A type we guessed is a weaker basis than one the contractor set.
      confidence: e.typeSource === "suggested" ? "low" : e.check.confidence,
      confidenceReason:
        e.typeSource === "suggested"
          ? `${e.check.confidenceReason} The job type (${e.typeLabel}) is our suggestion; confirm it on the Estimate Check.`
          : e.check.confidenceReason,
      notEmailed: e.notEmailed,
      typeLabel: e.typeLabel,
      historyJobs: e.check.historyJobs,
    }));

  const feed = computeOpportunityFeed({
    now,
    jobs,
    forecasts: profitData.forecasts,
    mixes,
    targetFilledEstimates,
    typeLabel,
    estimateFlags,
    jobsAreCustomers: connection.jobSource === "customers",
    idleOpenJobs: profitData.dataHealth.idleOpenJobs.length,
  });

  return { feed, estimates, jobTypes, mixes, jobs, profitData };
}

export function estimateLabel(e: { docNumber: string | null; customerName: string | null }): string {
  const who = e.customerName ? ` for ${e.customerName.split(":").pop()}` : "";
  return e.docNumber ? `Estimate ${e.docNumber}${who}` : `Estimate${who || " (no number)"}`;
}

export interface TrackedActionView {
  id: string;
  title: string;
  action: string;
  kind: string;
  subjectKey: string;
  subjectLabel: string;
  costCategory: CoreCategory | null;
  baselineMarginPct: number;
  baselineJobs: number;
  targetMarginPct: number | null;
  startedAt: Date;
  stoppedAt: Date | null;
  outcome: ActionOutcome;
}

/** The pricing changes this company is tracking, each with its result so far. */
export async function getTrackedActions(connectionId: string, data: Pick<OpportunityData, "jobs" | "mixes" | "jobTypes">): Promise<TrackedActionView[]> {
  const rows = await prisma.profitAction.findMany({ where: { connectionId }, orderBy: { startedAt: "desc" } });
  return rows.map((r) => {
    const costCategory = (r.costCategory as CoreCategory | null) ?? null;
    const baselineMarginPct = Number(r.baselineMarginPct);
    const kind = r.kind as "job_type" | "customer" | "small_jobs" | "cost_category";
    return {
      id: r.id,
      title: r.title,
      action: r.action,
      kind: r.kind,
      subjectKey: r.subjectKey,
      subjectLabel:
        kind === "job_type"
          ? labelForJobType(data.jobTypes, r.subjectKey)
          : kind === "small_jobs"
            ? `Jobs under $${Number(r.subjectKey).toLocaleString("en-US")}`
            : kind === "customer"
              ? r.subjectKey
              : "All jobs",
      costCategory,
      baselineMarginPct,
      baselineJobs: r.baselineJobs,
      targetMarginPct: r.targetMarginPct == null ? null : Number(r.targetMarginPct),
      startedAt: r.startedAt,
      stoppedAt: r.stoppedAt,
      outcome: computeActionOutcome(
        { kind, subjectKey: r.subjectKey, costCategory, baselineMarginPct, baselineJobs: r.baselineJobs, startedAt: r.startedAt },
        data.jobs,
        data.mixes
      ),
    };
  });
}
