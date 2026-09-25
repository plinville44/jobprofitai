import { prisma } from "@/lib/prisma";
import {
  getConnectionProfitData,
  type ForecastResult,
  type JobFinancials,
  type NeedsAttentionItem,
} from "@/lib/profitability";

/**
 * Mid-week profit alerts.
 *
 * The weekly brief says what happened; these say it as soon as the nightly
 * sync sees it: an open job goes 10% or more over its estimate, a Pro
 * forecast drops below target, or a job gets well ahead of its billing.
 *
 * Each alert is sent once per job and kind:
 *   - A row is recorded the first time the condition is seen, and marked
 *     emailed only after an email actually went out (markAlertsSent). One
 *     that couldn't be sent yet (owner not verified, every send failed) is
 *     still pending and goes with the next run.
 *   - It is re-armed only when the condition has clearly cleared, with some
 *     margin (see hasCleared), or the job is finished. A figure that simply
 *     can't be worked out any more (an estimate removed, a forecast that
 *     became unavailable, a plan without forecasts) doesn't count as
 *     cleared, so it can't fire again the moment it comes back.
 *
 * The first evaluation for a company only records what is already true. A
 * newly connected company with twenty jobs already over budget gets that in
 * its first brief, not as twenty alerts.
 */
export const ALERT_KINDS: Record<string, string> = {
  over_budget: "Over its estimate",
  forecast_below_target: "Forecast below target",
  underbilled: "Work done, not billed",
};

export interface NewAlert {
  jobId: string;
  jobName: string;
  kind: string;
  issue: string;
  financialImpact: number | null;
}

/** Whether an alert's condition has clearly gone away (not merely become unmeasurable). */
export function hasCleared(kind: string, job: JobFinancials | undefined, forecast: ForecastResult | undefined): boolean {
  // Finished or gone: nothing left to warn about.
  if (!job || job.status !== "open") return true;
  switch (kind) {
    case "over_budget":
      // Raised past 10% over; re-armed once back within 5%.
      return job.varianceVsEstimatePct != null && job.varianceVsEstimatePct <= 0.05;
    case "forecast_below_target":
      return (
        forecast?.available === true &&
        forecast.forecastMarginPct != null &&
        job.targetMarginPct != null &&
        // A point above target, so a forecast hovering at it doesn't repeat.
        forecast.forecastMarginPct * 100 >= job.targetMarginPct + 1
      );
    case "underbilled": {
      // Raised past $1,000 and 5% of the contract; re-armed once under
      // half of both.
      if (!job.wip || job.estimatedRevenue == null) return false;
      const under = -job.wip.overUnderBilling;
      return under <= Math.max(500, job.estimatedRevenue * 0.025);
    }
    default:
      return true;
  }
}

export async function evaluateAlerts(
  connectionId: string,
  now: Date = new Date()
): Promise<{ pending: NewAlert[]; baseline: boolean }> {
  const connection = await prisma.quickBooksConnection.findUniqueOrThrow({
    where: { id: connectionId },
    select: { alertsBaselinedAt: true },
  });
  const data = await getConnectionProfitData(connectionId, now, { statusFilter: "open" });
  const openJobs = new Map(data.jobs.filter((j) => j.status === "open").map((j) => [j.jobId, j]));

  const current = new Map<string, NeedsAttentionItem>();
  for (const item of data.needsAttention) {
    if (!(item.issueCode in ALERT_KINDS)) continue;
    // Alerts are for work still in progress.
    if (!openJobs.has(item.jobId)) continue;
    current.set(`${item.jobId}:${item.issueCode}`, item);
  }

  const existing = await prisma.jobAlert.findMany({
    where: { job: { connectionId } },
    select: { id: true, jobId: true, kind: true, emailed: true },
  });
  const existingByKey = new Map(existing.map((a) => [`${a.jobId}:${a.kind}`, a]));

  const cleared = existing
    .filter((a) => !current.has(`${a.jobId}:${a.kind}`))
    .filter((a) => hasCleared(a.kind, openJobs.get(a.jobId), data.forecasts.get(a.jobId)))
    .map((a) => a.id);
  if (cleared.length) await prisma.jobAlert.deleteMany({ where: { id: { in: cleared } } });

  const baseline = connection.alertsBaselinedAt == null;
  const pending: NewAlert[] = [];
  for (const [key, item] of current) {
    const row = existingByKey.get(key);
    if (!row) {
      await prisma.jobAlert.upsert({
        where: { jobId_kind: { jobId: item.jobId, kind: item.issueCode } },
        // On the baseline run it's recorded as already known, never sent.
        create: { jobId: item.jobId, kind: item.issueCode, emailed: baseline },
        update: {},
      });
      if (baseline) continue;
    } else if (row.emailed) {
      continue;
    }
    pending.push({
      jobId: item.jobId,
      jobName: item.jobName,
      kind: item.issueCode,
      issue: item.issue,
      financialImpact: item.financialImpact,
    });
  }
  if (baseline) {
    await prisma.quickBooksConnection.update({ where: { id: connectionId }, data: { alertsBaselinedAt: now } });
  }
  pending.sort((a, b) => (b.financialImpact ?? 0) - (a.financialImpact ?? 0));
  return { pending, baseline };
}

/** Records that these alerts reached at least one recipient. */
export async function markAlertsSent(alerts: Pick<NewAlert, "jobId" | "kind">[]): Promise<void> {
  for (const a of alerts) {
    await prisma.jobAlert.updateMany({ where: { jobId: a.jobId, kind: a.kind }, data: { emailed: true } });
  }
}
