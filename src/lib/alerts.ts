import { prisma } from "@/lib/prisma";
import {
  getConnectionProfitData,
  type ForecastResult,
  type JobFinancials,
  type NeedsAttentionItem,
} from "@/lib/profitability";
import { isOverPlanLimit } from "@/lib/planLimits";
import { basisCutoff, rebuildPending } from "@/lib/weekOverWeek";

/**
 * Mid-week profit alerts.
 *
 * The weekly brief says what happened; these say it as soon as the nightly
 * sync sees it: an open job goes 10% or more over its estimate, a Pro
 * forecast drops below target, or a job gets well ahead of its billing.
 * "Over its estimate" is only for a cost estimate the contractor gave, never
 * one filled in from the target margin, the same as the brief's tile (see
 * estimateFromTargetMargin in computeNeedsAttentionForJob).
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
 *
 * The same quiet "baseline" run follows any change in how the figures are
 * worked out (alertsNeedBaseline): a new labor burden, a switch of job
 * setup, time-entry labor turned on or off, a rebuild under a new sync
 * version. Those move every job's figures at once with nothing happening
 * on the jobs; a switch of job setup even gives every job a new id. Without
 * this, each one emailed the owner a pile of "new" alerts the next night.
 * A baseline run also settles alerts still waiting to be sent, so they
 * don't go out afterwards on figures worked out the old way.
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

/**
 * Whether the next evaluation should only record conditions, not email
 * them: never baselined (a new company, or Settings cleared it), or the
 * figures' basis changed after the last baseline. Pure, for tests.
 */
export function alertsNeedBaseline(c: {
  alertsBaselinedAt: Date | null;
  laborBurdenSetAt?: Date | null;
  basisChangedAt?: Date | null;
  rebuildRequestedAt?: Date | null;
  lastFullSyncAt?: Date | null;
}): boolean {
  if (c.alertsBaselinedAt == null) return true;
  // Settings asked for a rebuild that hasn't synced: today's figures are
  // the old ones, and tomorrow's will be different again.
  if (rebuildPending(c)) return true;
  const cutoff = basisCutoff(c);
  return cutoff != null && cutoff > c.alertsBaselinedAt;
}

export async function evaluateAlerts(
  connectionId: string,
  now: Date = new Date()
): Promise<{ pending: NewAlert[]; baseline: boolean; paused?: boolean }> {
  const connection = await prisma.quickBooksConnection.findUniqueOrThrow({
    where: { id: connectionId },
    select: {
      userId: true,
      alertsBaselinedAt: true,
      laborBurdenSetAt: true,
      basisChangedAt: true,
      rebuildRequestedAt: true,
      lastFullSyncAt: true,
    },
  });

  // A company the plan doesn't cover (see planLimits.ts) gets no alert
  // emails. Its baseline is cleared, so the first run after it's covered
  // again records what built up meanwhile instead of emailing it all at
  // once; the weekly brief covers that.
  if (await isOverPlanLimit({ id: connectionId, userId: connection.userId })) {
    if (connection.alertsBaselinedAt != null) {
      await prisma.quickBooksConnection.update({ where: { id: connectionId }, data: { alertsBaselinedAt: null } });
    }
    return { pending: [], baseline: false, paused: true };
  }

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

  const baseline = alertsNeedBaseline(connection);
  const pending: NewAlert[] = [];
  const settle: string[] = [];
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
    } else if (baseline) {
      // Waiting to be sent from before the change: settled, not sent.
      settle.push(row.id);
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
    // Rows waiting from before the change whose condition isn't current
    // any more (a figure that became unmeasurable) are settled too, so they
    // can't be sent the moment it comes back.
    for (const a of existing) if (!a.emailed && !cleared.includes(a.id) && !settle.includes(a.id)) settle.push(a.id);
    if (settle.length) await prisma.jobAlert.updateMany({ where: { id: { in: settle } }, data: { emailed: true } });
    // Left unset while a rebuild is still waiting for its sync, so the run
    // after it records the rebuilt figures quietly too.
    await prisma.quickBooksConnection.update({
      where: { id: connectionId },
      data: { alertsBaselinedAt: rebuildPending(connection) ? null : now },
    });
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
