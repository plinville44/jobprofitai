import { Prisma } from "@prisma/client";
import { prisma } from "./prisma";

export interface JobMetrics {
  jobId: string;
  jobName: string;
  customerName: string | null;
  status: string;
  estimatedCost: number | null;
  actualCost: number;
  estimatedRevenue: number | null;
  actualRevenue: number;
  costByCategory: Record<string, number>;
  marginPct: number | null; // (actualRevenue - actualCost) / actualRevenue, null if no revenue yet
  varianceVsEstimate: number | null; // actualCost - estimatedCost, positive = over budget
  varianceVsEstimatePct: number | null;
  flags: string[]; // human-relevant callouts, e.g. "over budget", "no estimate on file"
}

export interface ConnectionMetrics {
  connectionId: string;
  weekStarting: Date;
  jobs: JobMetrics[];
  topConcerns: JobMetrics[]; // jobs worth calling out in the digest, worst first
  totals: {
    activeJobs: number;
    totalActualCost: number;
    totalActualRevenue: number;
    blendedMarginPct: number | null;
  };
}

const toNum = (d: Prisma.Decimal | null | undefined): number =>
  d == null ? 0 : Number(d);

/**
 * Computes this week's profitability picture for every open job on a connection.
 * This is the ground truth the AI narrative (src/lib/digest.ts) is required to
 * be grounded in - it never invents a number that isn't in this output.
 */
export async function computeConnectionMetrics(
  connectionId: string,
  weekStarting: Date
): Promise<ConnectionMetrics> {
  const jobs = await prisma.job.findMany({
    where: { connectionId },
    include: { costEntries: true, invoices: true },
  });

  const jobMetrics: JobMetrics[] = jobs.map((job) => {
    const actualCost = job.costEntries.reduce((sum, c) => sum + toNum(c.amount), 0);
    const actualRevenue = job.invoices.reduce((sum, inv) => sum + toNum(inv.amount), 0);

    const costByCategory: Record<string, number> = {};
    for (const c of job.costEntries) {
      costByCategory[c.category] = (costByCategory[c.category] ?? 0) + toNum(c.amount);
    }

    const estimatedCost = job.estimatedCost == null ? null : toNum(job.estimatedCost);
    const estimatedRevenue = job.estimatedRevenue == null ? null : toNum(job.estimatedRevenue);

    const marginPct = actualRevenue > 0 ? (actualRevenue - actualCost) / actualRevenue : null;

    const varianceVsEstimate = estimatedCost == null ? null : actualCost - estimatedCost;
    const varianceVsEstimatePct =
      estimatedCost && estimatedCost !== 0 && varianceVsEstimate != null
        ? varianceVsEstimate / estimatedCost
        : null;

    const flags: string[] = [];
    if (estimatedCost == null) flags.push("no_estimate_on_file");
    if (varianceVsEstimatePct != null && varianceVsEstimatePct > 0.1)
      flags.push("over_budget_10pct_plus");
    if (marginPct != null && marginPct < 0.1 && actualRevenue > 0)
      flags.push("thin_margin_under_10pct");
    if (job.status === "open" && job.endDate && job.endDate < new Date())
      flags.push("past_end_date_still_open");

    return {
      jobId: job.id,
      jobName: job.name,
      customerName: job.customerName,
      status: job.status,
      estimatedCost,
      actualCost,
      estimatedRevenue,
      actualRevenue,
      costByCategory,
      marginPct,
      varianceVsEstimate,
      varianceVsEstimatePct,
      flags,
    };
  });

  // Worst-first: flagged jobs first (more flags = more concerning), then by
  // dollar variance over estimate. This ordering is what the digest leads with.
  const topConcerns = [...jobMetrics]
    .filter((j) => j.flags.length > 0)
    .sort((a, b) => {
      if (b.flags.length !== a.flags.length) return b.flags.length - a.flags.length;
      return (b.varianceVsEstimate ?? 0) - (a.varianceVsEstimate ?? 0);
    })
    .slice(0, 5);

  const activeJobs = jobMetrics.filter((j) => j.status === "open").length;
  const totalActualCost = jobMetrics.reduce((s, j) => s + j.actualCost, 0);
  const totalActualRevenue = jobMetrics.reduce((s, j) => s + j.actualRevenue, 0);
  const blendedMarginPct =
    totalActualRevenue > 0 ? (totalActualRevenue - totalActualCost) / totalActualRevenue : null;

  return {
    connectionId,
    weekStarting,
    jobs: jobMetrics,
    topConcerns,
    totals: { activeJobs, totalActualCost, totalActualRevenue, blendedMarginPct },
  };
}
