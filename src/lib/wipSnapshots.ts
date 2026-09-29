import type { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import { getConnectionProfitData } from "./profitability";
import { buildWipSchedule, type WipSchedule } from "./wipSchedule";
import { isValidTimeZone, localParts, zonedTimeToUtc } from "./schedule";
import { DEFAULT_TIME_ZONE } from "./format";

/**
 * Month-end WIP snapshots: a copy of each company's Work in Progress
 * schedule as the books stood at the end of each month (the WipSnapshot
 * model). A later month-end report compares them to show how each job's
 * expected profit moved ("profit fade"), which sureties and banks watch.
 * History like that can only be collected as it happens, so it's saved now.
 *
 * The rules, all in company time (the connection's emailTimezone):
 *  - A month's snapshot counts only costs and invoices dated on or before its
 *    last day (getConnectionProfitData's asOf).
 *  - Bookkeepers finish a month's entries some days after it ends, so the
 *    snapshot is taken after the month ends and worked out again once a day
 *    through the 20th of the next month. After that it's frozen (frozenAt)
 *    and never changed again.
 *  - A month that was never taken (every run in its window missed it) is
 *    taken once, frozen at once and marked takenLate. Only the last month
 *    whose window has closed can be taken late: older months aren't made up
 *    from today's contract values and statuses.
 *  - Only for a company that is connected, not paused by its plan's company
 *    limit (src/lib/planLimits.ts), whose last sync finished after the month
 *    ended, and that was connected before the month ended.
 *  - At most one snapshot worked out per company per day.
 *
 * The nightly sync takes them after its syncs and alert emails are done
 * (src/app/api/cron/nightly-sync/route.ts). The rules are pure functions,
 * tested in src/lib/__tests__/wipSnapshots.test.ts.
 */

/** A month's snapshot is worked out again daily through this day of the next month, then frozen. */
export const REFRESH_THROUGH_DAY = 20;

// ---------------------------------------------------------------------------
// Periods. A period is keyed by its last day, stored as UTC midnight of that
// date (the WipSnapshot.periodEnd column, and how QuickBooks dates are kept).
// ---------------------------------------------------------------------------

/** The last day of the month that most recently ended in `timeZone`. Pure. */
export function lastEndedPeriodEnd(now: Date, timeZone: string): Date {
  const p = localParts(now, timeZone);
  return new Date(Date.UTC(p.year, p.month, 0));
}

/** The last day of the month before the one `periodEnd` ends. Pure. */
export function previousPeriodEnd(periodEnd: Date): Date {
  return new Date(Date.UTC(periodEnd.getUTCFullYear(), periodEnd.getUTCMonth(), 0));
}

/** The instant the period ended: midnight after its last day, company time. Pure. */
export function periodEndedAt(periodEnd: Date, timeZone: string): Date {
  return zonedTimeToUtc(periodEnd.getUTCFullYear(), periodEnd.getUTCMonth(), periodEnd.getUTCDate() + 1, 0, timeZone);
}

/** When the period's snapshot stops being refreshed: midnight after the 20th of the next month, company time. Pure. */
export function refreshWindowClosesAt(periodEnd: Date, timeZone: string): Date {
  return zonedTimeToUtc(periodEnd.getUTCFullYear(), periodEnd.getUTCMonth() + 1, REFRESH_THROUGH_DAY + 1, 0, timeZone);
}

/** Whether a snapshot should now be frozen. Pure. */
export function shouldFreeze(s: { periodEnd: Date; frozenAt: Date | null }, now: Date, timeZone: string): boolean {
  return s.frozenAt == null && now.getTime() >= refreshWindowClosesAt(s.periodEnd, timeZone).getTime();
}

const localDay = (d: Date, timeZone: string) => {
  const p = localParts(d, timeZone);
  return `${p.year}-${p.month}-${p.day}`;
};

// ---------------------------------------------------------------------------
// What to do for one company tonight
// ---------------------------------------------------------------------------

export interface SnapshotCompany {
  connectedAt: Date;
  disconnectedAt: Date | null;
  lastSyncStatus: string | null;
  /** When the last finished sync started (the sync sets it so). */
  lastSyncedAt: Date | null;
  /** Set while a full sync is owed or stopped partway. */
  fullSyncContinueAt: Date | null;
  /** Past the plan's company limit (src/lib/planLimits.ts). */
  paused: boolean;
}

export interface ExistingSnapshot {
  periodEnd: Date;
  takenAt: Date;
  frozenAt: Date | null;
}

export type SnapshotStep =
  | { action: "take"; periodEnd: Date; late: boolean }
  | { action: "refresh"; periodEnd: Date }
  | { action: "none"; reason: string };

/**
 * The one snapshot to take or refresh for a company now, if any. `existing`
 * is the company's snapshots for the last two ended months (more is fine).
 * Freezing is separate (shouldFreeze), since it's due whether or not the
 * company can be synced. Pure.
 */
export function nextSnapshotStep(
  now: Date,
  timeZone: string,
  company: SnapshotCompany,
  existing: ExistingSnapshot[]
): SnapshotStep {
  const none = (reason: string): SnapshotStep => ({ action: "none", reason });
  if (company.disconnectedAt) return none("not connected");
  if (company.paused) return none("paused: past the plan's company limit");
  // A failed sync, or a full sync partway through with its figures part
  // rewritten: wait for a clean one.
  if (company.lastSyncStatus !== "success" || company.fullSyncContinueAt != null) return none("last sync didn't finish");
  const today = localDay(now, timeZone);
  if (existing.some((s) => localDay(s.takenAt, timeZone) === today)) return none("already worked out today");

  // Connected before the month ended, and synced since: the sync reads the
  // month's last entries only once the month is over.
  const eligible = (periodEnd: Date) => {
    const endedAt = periodEndedAt(periodEnd, timeZone).getTime();
    return company.connectedAt.getTime() < endedAt && company.lastSyncedAt != null && company.lastSyncedAt.getTime() >= endedAt;
  };
  const find = (periodEnd: Date) => existing.find((s) => s.periodEnd.getTime() === periodEnd.getTime());

  const latest = lastEndedPeriodEnd(now, timeZone);
  const current = find(latest);
  if (now.getTime() < refreshWindowClosesAt(latest, timeZone).getTime()) {
    if (!current && eligible(latest)) return { action: "take", periodEnd: latest, late: false };
    // The month before, if every run in its window and since missed it. Ahead
    // of the day's refresh: that one only skips a day.
    const before = previousPeriodEnd(latest);
    if (!find(before) && eligible(before)) return { action: "take", periodEnd: before, late: true };
    if (current && current.frozenAt == null && eligible(latest)) return { action: "refresh", periodEnd: latest };
    return none(current ? "frozen" : "not connected before the month ended, or not synced since");
  }
  if (!current && eligible(latest)) return { action: "take", periodEnd: latest, late: true };
  return none(current ? "month's window has closed" : "not connected before the month ended, or not synced since");
}

/** What a snapshot stores from the schedule: exactly what buildWipSchedule produced. Pure. */
export function snapshotFigures(s: WipSchedule) {
  return {
    inProgress: s.inProgress,
    totals: s.totals,
    notScheduled: s.notScheduled,
    completedTotals: s.completedTotals,
    completed: s.completed,
    idle: s.idle,
  };
}

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

const json = (v: unknown) => v as Prisma.InputJsonValue;

export interface SnapshotResult {
  connectionId: string;
  status: "taken" | "refreshed" | "skipped" | "error";
  detail?: string;
}

/**
 * Takes or refreshes one company's snapshot, if one is due (nextSnapshotStep).
 * Never throws: a failure is returned, and the next run tries again.
 */
export async function takeWipSnapshot(connectionId: string, opts: { paused: boolean; now?: Date }): Promise<SnapshotResult> {
  const now = opts.now ?? new Date();
  try {
    const connection = await prisma.quickBooksConnection.findUnique({
      where: { id: connectionId },
      select: {
        emailTimezone: true,
        connectedAt: true,
        disconnectedAt: true,
        lastSyncStatus: true,
        lastSyncedAt: true,
        fullSyncContinueAt: true,
        syncVersion: true,
        laborBurdenPct: true,
        jobSource: true,
        laborFromTimeEntries: true,
        basisChangedAt: true,
        laborBurdenSetAt: true,
      },
    });
    if (!connection) return { connectionId, status: "skipped", detail: "company not found" };
    const timeZone = isValidTimeZone(connection.emailTimezone) ? connection.emailTimezone : DEFAULT_TIME_ZONE;
    const existing = await prisma.wipSnapshot.findMany({
      where: { connectionId, periodEnd: { gte: previousPeriodEnd(lastEndedPeriodEnd(now, timeZone)) } },
      select: { periodEnd: true, takenAt: true, frozenAt: true },
    });
    const step = nextSnapshotStep(now, timeZone, { ...connection, paused: opts.paused }, existing);
    if (step.action === "none") return { connectionId, status: "skipped", detail: step.reason };

    // The schedule the WIP report shows, as the books stood at the end of the
    // month: every job (so completed contracts are there too), with costs and
    // invoices dated after the month dropped, and idle and 12-month windows
    // measured from the month's end. Contract values, cost estimates, percent
    // complete and job status are as stored now: there is no history of them.
    const endedAt = periodEndedAt(step.periodEnd, timeZone);
    const [data, filled] = await Promise.all([
      getConnectionProfitData(connectionId, endedAt, { asOf: step.periodEnd }),
      prisma.job.findMany({ where: { connectionId, estimatedCostSource: "target_margin" }, select: { id: true } }),
    ]);
    const figures = snapshotFigures(buildWipSchedule(data.lifetimeJobs, endedAt, new Set(filled.map((j) => j.id))));
    // The moment the step was decided, seconds before the write, so "once a
    // day" is judged by the same clock that chose it.
    const takenAt = now;
    const values = {
      takenAt,
      syncVersion: connection.syncVersion,
      laborBurdenPct: connection.laborBurdenPct,
      jobSource: connection.jobSource,
      laborFromTimeEntries: connection.laborFromTimeEntries,
      basisChangedAt: connection.basisChangedAt,
      laborBurdenSetAt: connection.laborBurdenSetAt,
      inProgress: json(figures.inProgress),
      totals: json(figures.totals),
      notScheduled: json(figures.notScheduled),
      completedTotals: json(figures.completedTotals),
      completed: json(figures.completed),
      idle: json(figures.idle),
    };
    const month = step.periodEnd.toISOString().slice(0, 7);

    if (step.action === "take") {
      try {
        await prisma.wipSnapshot.create({
          data: { connectionId, periodEnd: step.periodEnd, ...values, takenLate: step.late, frozenAt: step.late ? takenAt : null },
        });
      } catch (err) {
        // Another run took it a moment ago.
        if ((err as { code?: string })?.code === "P2002") return { connectionId, status: "skipped", detail: `${month} already taken` };
        throw err;
      }
      return { connectionId, status: "taken", detail: step.late ? `${month}, late and frozen` : month };
    }
    // Only while not frozen, checked in the write itself, so a snapshot
    // frozen while this one was being worked out is left exactly as it was.
    const updated = await prisma.wipSnapshot.updateMany({
      where: { connectionId, periodEnd: step.periodEnd, frozenAt: null },
      data: values,
    });
    return updated.count > 0
      ? { connectionId, status: "refreshed", detail: month }
      : { connectionId, status: "skipped", detail: `${month} is frozen` };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error(`wip-snapshots: failed for connection ${connectionId}: ${message}`);
    return { connectionId, status: "error", detail: message };
  }
}

/**
 * Freezes every snapshot whose refresh window has closed in its company's
 * time zone, whether or not the company synced: paused and disconnected
 * companies' snapshots are frozen on time too. Frozen ones are never
 * touched. Returns how many were frozen.
 */
export async function freezeClosedSnapshots(now: Date = new Date()): Promise<number> {
  // No window closes before the 20th of the month following the snapshot's
  // month, in any time zone. So before the 20th (UTC) only snapshots of
  // earlier months can be due, which keeps this month's open ones (one per
  // company) out of the query on most days.
  const monthsBack = now.getUTCDate() >= REFRESH_THROUGH_DAY ? 0 : 1;
  const before = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - monthsBack, 1));
  const open = await prisma.wipSnapshot.findMany({
    where: { frozenAt: null, periodEnd: { lt: before } },
    select: { id: true, periodEnd: true, frozenAt: true, connection: { select: { emailTimezone: true } } },
    orderBy: { periodEnd: "asc" },
    take: 1000,
  });
  const due = open
    .filter((s) => shouldFreeze(s, now, isValidTimeZone(s.connection.emailTimezone) ? s.connection.emailTimezone : DEFAULT_TIME_ZONE))
    .map((s) => s.id);
  if (due.length === 0) return 0;
  const frozen = await prisma.wipSnapshot.updateMany({ where: { id: { in: due }, frozenAt: null }, data: { frozenAt: now } });
  return frozen.count;
}
