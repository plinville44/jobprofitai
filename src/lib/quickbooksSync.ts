import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { qboQuery, qboQueryAll, qboCompanyInfo, qboCdc, refreshTokens } from "@/lib/quickbooks";
import { encryptToken, decryptToken } from "@/lib/crypto";
import {
  buildJobIndex,
  classJobKey,
  contractValueFromEstimates,
  costEntryId,
  depositCostLines,
  depositRevenueLines,
  emptyLookups,
  estimateFromTxn,
  estimateRowId,
  expenseLines,
  expenseRevenueLines,
  journalRevenueLines,
  customersCreatedSince,
  lineRevenueId,
  parentsNeedingFullSync,
  qboDate,
  resolveJob,
  revenueByClass,
  revenueFromTxn,
  revenueId,
  round2,
  selectJobClasses,
  selectJobCustomers,
  timeActivityCost,
  type JobCandidate,
  type AccountInfo,
  type ExpenseSourceType,
  type ItemInfo,
  type JobIndex,
  type JobSource,
  type LineRevenueSourceType,
  type Lookups,
  type RevenueSourceType,
} from "@/lib/qboNormalize";
import { syncMayPickJobSource } from "@/lib/jobSetup";
import { isUntaggedJobCost, UntaggedCostCollector } from "@/lib/untaggedCosts";
import { replaceUntaggedCosts, replaceUntaggedCostsForTxns } from "@/lib/untaggedCostStore";

/**
 * The QuickBooks sync engine: reads a connection's job-costing data from
 * QuickBooks and writes it into Job / CostEntry / InvoiceSummary /
 * JobEstimate, so every page and the weekly brief run on local data.
 *
 * Called by POST /api/quickbooks/sync (a person clicking Sync now), by the
 * nightly sync cron and by the weekly-email cron. Callers decide whether the
 * caller may sync this connection; this module only does the work.
 *
 * What a payload MEANS (bill rate vs cost rate, refunds, tax, which
 * customers are jobs) is decided in src/lib/qboNormalize.ts, which is pure
 * and tested. This file is the database side: it keeps local rows exactly
 * in step with QuickBooks, which means it also REMOVES rows. A full sync
 * deletes every stored row QuickBooks no longer returns (a deleted bill, a
 * voided check, a line moved to another job), and an incremental sync
 * removes what Change Data Capture reports as deleted or changed.
 *
 * Every run is recorded as a SyncRun, and a connection can only have one
 * sync running at a time (see claimSync).
 */

/**
 * Bump when the way rows are stored changes. A connection whose
 * syncVersion is lower gets a full sync next time, which rewrites every
 * row under the new rules and sweeps away rows stored under the old ones.
 *
 * 2: row ids include the connection id; labor at cost rate; refunds,
 *    vendor credits, sales receipts, credit memos, journal entries; tax
 *    removed from revenue; deletions honoured.
 * 3: estimate lines, numbers, email status and expiry dates, for the
 *    Estimate Check and estimate accuracy by cost category.
 * 4: revenue from bank deposits and journal entries that name a customer
 *    (income recorded without an invoice).
 * 5: jobs by QuickBooks Class; hours on time entries; quantities and item
 *    costs on estimate lines; open invoice balances; lines posted to
 *    balance-sheet and income accounts no longer counted as job cost.
 * 6: journal entries judged by the same account rule as bills, so closing
 *    Construction in Progress to cost of goods sold counts once; retainage
 *    and other receivable asset accounts never count as cost; income lines on
 *    checks, bills and vendor credits (a refund check to a customer) stored
 *    as revenue; supplier refunds deposited to a cost account reduce the
 *    job's cost; a discount with its own class comes off that class only;
 *    time entries with start and end times always have the break taken off.
 */
export const SYNC_VERSION = 6;

/**
 * The last version that changed how COSTS and REVENUE are stored. The weekly
 * brief waits for a company's upgrade sync only below this, because only
 * those upgrades can make figures read wrong mid-way. Version 3 only adds
 * estimate details, so a brief never waits on it. Version 4 adds revenue
 * (bank deposits and journal entries), so a brief waits for it rather than
 * going out with some jobs upgraded and others not. Version 5 stops counting
 * balance-sheet postings as cost, so it waits for that too. Version 6 changes
 * journal entry costs, refunds and deposits, so it waits for that as well.
 */
export const COST_SYNC_VERSION = 6;

const FULL_SYNC_INTERVAL_DAYS = 30;
/** Data Health tallies look at the last 12 months, not the company's whole history. */
const COUNTER_WINDOW_DAYS = 365;
/** A sync that has been "in progress" longer than this is assumed dead. */
const STALE_SYNC_MINUTES = 10;
/** Incremental syncs re-read this much before the last sync's start. */
const CDC_OVERLAP_MS = 5 * 60_000;
/** QuickBooks' Change Data Capture returns at most this many records. */
const CDC_MAX_PER_ENTITY = 1000;

const EXPENSE_TYPES: ExpenseSourceType[] = ["Purchase", "Bill", "VendorCredit", "JournalEntry"];
const REVENUE_TYPES: RevenueSourceType[] = ["Invoice", "SalesReceipt", "CreditMemo", "RefundReceipt"];
const CDC_ENTITIES = ["Customer", ...EXPENSE_TYPES, "TimeActivity", ...REVENUE_TYPES, "Deposit", "Estimate"];
/** Classes are only asked for when jobs are classes: companies on plans without class tracking have none to send. */
const cdcEntitiesFor = (jobSource: JobSource) => (jobSource === "classes" ? ["Class", ...CDC_ENTITIES] : CDC_ENTITIES);
/**
 * Source types stored as revenue rows (InvoiceSummary). Every expense type
 * is one too: a journal entry's income lines, and a refund check to a
 * customer posted to an income account.
 */
const REVENUE_ROW_TYPES = new Set<string>([...REVENUE_TYPES, "Deposit", ...EXPENSE_TYPES]);
/** Source types stored as cost rows (CostEntry). Deposit is also a revenue type: a supplier refund deposited to a cost account is a cost reduction. */
const COST_ROW_TYPES = new Set<string>([...EXPENSE_TYPES, "TimeActivity", "Deposit"]);

// ---------------------------------------------------------------------------
// Full syncs over several runs
// ---------------------------------------------------------------------------

/**
 * A full sync's steps, in order: the jobs, then each data type. Each step is
 * read from QuickBooks in full before any of its stored rows are changed or
 * removed, and nothing in a later step depends on an earlier step's rows, so
 * a full sync can stop between two steps and carry on in a later run with
 * the steps it hadn't done.
 *
 * That is what the deadline is for (see runSyncForConnection). The platform
 * stops a function at its time limit wherever it is, so a company with years
 * of history whose full sync took longer never finished, and was retried
 * every hour, taking the rest of that hour's work down with it each time.
 */
export const FULL_SYNC_STEPS: readonly string[] = ["Jobs", ...EXPENSE_TYPES, "TimeActivity", ...REVENUE_TYPES, "Deposit", "Estimate"];
/** How long a step is expected to take when no earlier full sync timed it. */
const DEFAULT_STEP_MS = 30_000;
/** Reading the chart of accounts and product list, which every run does first ("Lookups" in stepMs). */
const DEFAULT_LOOKUPS_MS = 10_000;
/** A step timed before is expected to take this much longer, at least MIN_STEP_MS. */
const STEP_ESTIMATE_FACTOR = 1.5;
const MIN_STEP_MS = 5_000;
/**
 * How far past its deadline a run's first step may be expected to finish.
 * Callers keep at least a minute between their deadline and the function's
 * time limit (the nightly job 80 seconds, Sync now 60), and a run that does
 * nothing gets nowhere, so its first step may use most of that margin, but a
 * step expected to run into the time limit itself isn't started.
 */
const FIRST_STEP_GRACE_MS = 45_000;
/**
 * A run whose first step doesn't fit is left for the next one (see
 * runSyncForConnection), unless it started this soon after its caller's time
 * window opened: a later run would have no more time, so it goes ahead.
 */
const WINDOW_START_SLACK_MS = 30_000;
/**
 * Progress older than this is started over. The run that finishes a full
 * sync hands the next incremental sync the first run's start (see
 * runSyncForConnection), and QuickBooks' change feed only goes back 30 days.
 */
const MAX_PROGRESS_AGE_MS = 20 * 86_400_000;
/** Runs one full sync may take (stopped partway or cut off) before it's tried once a day and the company is told. */
export const FULL_SYNC_MAX_PARTS = 8;
/**
 * Runs cut off by the platform's time limit before the same. Fewer: each one
 * also ends every other sync and alert email in that run.
 */
export const FULL_SYNC_MAX_CUT_OFF = 3;
const DAY_MS = 86_400_000;
/** A full sync that failed partway is continued after this, like any failed sync. */
const RETRY_FAILED_FULL_SYNC_MS = 2 * 3_600_000;
/** What a sync the platform stopped at its time limit is closed with (see runSyncForConnection). */
const INTERRUPTED_MESSAGE = "Interrupted before it finished (time limit). Retried automatically.";
/**
 * The sync error a company gets when its full sync keeps running out of
 * time. Shown in Settings and, like any failed sync, flagged on every
 * dashboard page (src/lib/syncProblem.ts).
 */
export const FULL_SYNC_TOO_LONG_MESSAGE =
  "Reading this company's QuickBooks history keeps running out of time, so some of its figures may be out of date. It's tried again once a day. If this hasn't cleared in a few days, email support@jobprofitai.com.";

/**
 * Whether this company's next sync is a full one: never had one, the last
 * one was a while ago, its rows were stored under older rules, or one is
 * owed or partway (fullSyncContinueAt). Pure; the nightly job decides by it
 * which companies go to its full-sync slot.
 */
export function fullSyncDue(
  c: { lastFullSyncAt: Date | null; syncVersion: number; fullSyncContinueAt?: Date | null },
  now: number = Date.now()
): boolean {
  if (c.fullSyncContinueAt != null) return true;
  if (c.syncVersion < SYNC_VERSION) return true;
  return !c.lastFullSyncAt || now - c.lastFullSyncAt.getTime() > FULL_SYNC_INTERVAL_DAYS * DAY_MS;
}

/**
 * How long a step (or "Lookups") is expected to take. Pure. `history` is how
 * long each took when last timed.
 */
export function fullSyncStepMs(step: string, history: Record<string, number>): number {
  const last = history[step];
  if (typeof last === "number" && last > 0) return Math.max(MIN_STEP_MS, last * STEP_ESTIMATE_FACTOR);
  return step === "Lookups" ? DEFAULT_LOOKUPS_MS : DEFAULT_STEP_MS;
}

/**
 * Whether a full sync with a deadline has time to start this step. Pure.
 * `graceMs` lets it run that far past the deadline (a run's first step; see
 * FIRST_STEP_GRACE_MS).
 */
export function fullSyncStepFits(
  step: string,
  deadline: number | undefined,
  history: Record<string, number>,
  now: number = Date.now(),
  graceMs: number = 0
): boolean {
  if (deadline == null) return true;
  return now + fullSyncStepMs(step, history) <= deadline + graceMs;
}

/**
 * Whether a run's first step, after the lookups every run reads, is expected
 * to finish within its deadline plus FIRST_STEP_GRACE_MS. Pure.
 */
export function fullSyncFirstStepFits(
  step: string,
  deadline: number | undefined,
  history: Record<string, number>,
  now: number = Date.now()
): boolean {
  if (deadline == null) return true;
  return fullSyncStepFits(step, deadline, history, now + fullSyncStepMs("Lookups", history), FIRST_STEP_GRACE_MS);
}

/**
 * Whether a full sync, given the runs it has taken so far without finishing
 * (its SyncRun rows since the last finished one), still can't finish: it's
 * then tried once a day and the company is told. Pure.
 */
export function fullSyncStuck(runs: { status: string; errorMessage: string | null }[]): boolean {
  const cutOff = runs.filter((r) => r.status === "error" && r.errorMessage === INTERRUPTED_MESSAGE).length;
  const parts = runs.filter((r) => r.status === "partial").length + cutOff;
  return parts >= FULL_SYNC_MAX_PARTS || cutOff >= FULL_SYNC_MAX_CUT_OFF;
}

interface SyncTotals {
  costRowsWritten: number;
  costRowsUpdated: number;
  costRowsRemoved: number;
  revenueRowsUpdated: number;
  revenueRowsRemoved: number;
  /** See rebuildChangedFigures: summed over every run of a full sync. */
  figureRowsChanged: number;
}

const emptyTotals = (): SyncTotals => ({
  costRowsWritten: 0,
  costRowsUpdated: 0,
  costRowsRemoved: 0,
  revenueRowsUpdated: 0,
  revenueRowsRemoved: 0,
  figureRowsChanged: 0,
});

/**
 * Where a full sync that stopped partway got to, kept on its SyncRun row
 * (entitiesUpdated.fullSyncProgress) for the run that carries on. Counts and
 * tallies are running totals, so the run that finishes records the whole
 * sync's figures, which Data Health reads.
 */
export interface FullSyncProgress {
  /** When the first run started: every finished step's rows are at least this fresh. */
  startedAt: string;
  version: number;
  jobSource: JobSource;
  laborFromTimeEntries: boolean;
  /** Steps finished (FULL_SYNC_STEPS), whether QuickBooks sent that type or failed to. */
  done: string[];
  parts: number;
  jobs: number;
  fetched: Record<string, number>;
  tallies: Tallies;
  totals: SyncTotals;
  errors: Record<string, string>;
  stepMs: Record<string, number>;
  /** When this progress was last saved (after a step, or when the run stopped). */
  savedAt?: string;
}

/**
 * The progress a full sync may carry on from, or null to start over: one
 * made under other rules or another job setup, one older than a rebuild
 * Settings asked for since, one too old, or one some sync has finished since
 * (lastSyncedAt only moves when a sync finishes, a full sync over several
 * runs only when its last step does). Resuming that would skip steps whose
 * rows have moved on, and move lastSyncedAt back. Pure.
 */
export function usableFullSyncProgress(
  stored: unknown,
  c: { jobSource: string | null; laborFromTimeEntries: boolean; rebuildRequestedAt: Date | null; lastSyncedAt: Date | null },
  now: number = Date.now()
): FullSyncProgress | null {
  if (!stored || typeof stored !== "object") return null;
  const p = stored as Partial<FullSyncProgress>;
  const started = typeof p.startedAt === "string" ? new Date(p.startedAt).getTime() : NaN;
  if (!Number.isFinite(started) || !Array.isArray(p.done) || !p.tallies || !p.totals) return null;
  if (p.version !== SYNC_VERSION) return null;
  if (p.jobSource !== jobSourceOf(c.jobSource) || p.laborFromTimeEntries !== c.laborFromTimeEntries) return null;
  if (c.rebuildRequestedAt && c.rebuildRequestedAt.getTime() > started) return null;
  if (c.lastSyncedAt && c.lastSyncedAt.getTime() >= started) return null;
  if (now - started > MAX_PROGRESS_AGE_MS) return null;
  return p as FullSyncProgress;
}

function jobSourceOf(stored: string | null): JobSource {
  return (stored === "customers" || stored === "classes" ? stored : "projects") as JobSource;
}

/** Adds one run's tallies to the totals so far. */
function addTallies(a: Tallies, b: Tallies): Tallies {
  return {
    untaggedJobCostCount: a.untaggedJobCostCount + b.untaggedJobCostCount,
    untaggedJobCostAmount: a.untaggedJobCostAmount + b.untaggedJobCostAmount,
    untaggedOverheadCount: a.untaggedOverheadCount + b.untaggedOverheadCount,
    untaggedOverheadAmount: a.untaggedOverheadAmount + b.untaggedOverheadAmount,
    unresolvedExpenseCount: a.unresolvedExpenseCount + b.unresolvedExpenseCount,
    unresolvedExpenseAmount: a.unresolvedExpenseAmount + b.unresolvedExpenseAmount,
    costsMatchedViaParentCount: a.costsMatchedViaParentCount + b.costsMatchedViaParentCount,
    costsMatchedViaParentAmount: a.costsMatchedViaParentAmount + b.costsMatchedViaParentAmount,
    timeEntriesWithoutPayRate: a.timeEntriesWithoutPayRate + b.timeEntriesWithoutPayRate,
    vendorTimeEntriesSkipped: a.vendorTimeEntriesSkipped + b.vendorTimeEntriesSkipped,
    unresolvedSamples: [...a.unresolvedSamples, ...b.unresolvedSamples].slice(0, 5),
  };
}

export class SyncAlreadyRunningError extends Error {
  constructor() {
    super("A QuickBooks sync is already running for this company. Give it a minute and refresh.");
    this.name = "SyncAlreadyRunningError";
  }
}

/**
 * Thrown by an incremental-only sync (see runSyncForConnection) instead of
 * reading the company's whole history. The caller carries on with what is
 * already synced; the nightly sync does the full read.
 */
export class FullSyncNotAllowedError extends Error {
  constructor(reason: "full_sync_needed" | "change_feed_failed") {
    super(
      reason === "change_feed_failed"
        ? "QuickBooks' list of recent changes couldn't be read in full, so this sync stopped. The nightly sync will try again."
        : "This company needs a full read of its QuickBooks data, which is left to the nightly sync."
    );
    this.name = "FullSyncNotAllowedError";
  }
}

export async function runSyncForConnection(
  connectionId: string,
  options: {
    forceFull?: boolean;
    /**
     * Never run a full sync: throw FullSyncNotAllowedError instead, both when
     * one is due and when the change feed fails. For the weekly brief job,
     * where a full sync can outlast the whole run and take other companies'
     * briefs down with it.
     */
    incrementalOnly?: boolean;
    /**
     * When (ms since the epoch) this sync should be done by. A full sync
     * stops starting new steps when too little time is left before it, and
     * the next full sync carries on with the steps it hadn't done (see
     * FULL_SYNC_STEPS). For the nightly job, whose whole run has a time
     * limit. Without one, a full sync reads everything in one go.
     */
    deadline?: number;
    /**
     * Don't run a full sync here, leave it to the nightly job's one
     * full-sync slot: when one is due, or when the change feed fails, the
     * claim is handed back as it was, the next nightly run is made to do the
     * full sync, and FullSyncNotAllowedError is thrown. For the nightly job's
     * other workers, so only one full sync runs at a time.
     */
    deferFullSync?: boolean;
    /**
     * With forceFull: carry on from a full sync that stopped partway less
     * than this long ago, instead of starting again from the first step. For
     * Sync now, which has a deadline: a large company's second press picks
     * up where the first one stopped, rather than rereading the same steps
     * and never finishing.
     */
    resumeWithinMs?: number;
    /**
     * With a deadline: when the caller's time window opened (default: now).
     * A full sync whose first step wouldn't finish in time starts nothing
     * when called well into the window, and is first in line next time.
     */
    windowStart?: number;
  } = {}
): Promise<Record<string, any>> {
  const calledAt = Date.now();
  // What the claim overwrites, so a sync that doesn't run can hand it back
  // as it was: nothing ran, so nothing failed.
  const beforeClaim =
    options.incrementalOnly || options.deferFullSync || options.deadline != null
      ? await prisma.quickBooksConnection.findUnique({
          where: { id: connectionId },
          select: { lastSyncStatus: true, lastSyncAttemptAt: true },
        })
      : null;
  if (!(await claimSync(connectionId))) throw new SyncAlreadyRunningError();
  // Read after taking the claim, so the refresh token is the one the last
  // sync left behind, not one it rotated a moment ago.
  const connection = await prisma.quickBooksConnection.findUniqueOrThrow({ where: { id: connectionId } });
  const handBack = (extra: Prisma.QuickBooksConnectionUpdateManyMutationInput = {}) =>
    prisma.quickBooksConnection.updateMany({
      where: { id: connection.id, lastSyncStatus: "in_progress" },
      data: { lastSyncStatus: beforeClaim?.lastSyncStatus ?? null, lastSyncAttemptAt: beforeClaim?.lastSyncAttemptAt ?? null, ...extra },
    });

  // forceFull exists because an incremental sync cannot repair anything: it
  // only sees what QuickBooks says changed. The same goes for a connection
  // stored under an older version of these rules, and for a full sync that
  // stopped partway (see fullSyncDue).
  let mode: "full" | "incremental" = options.forceFull || fullSyncDue(connection) ? "full" : "incremental";

  // Checked here as well as by the caller: Settings can ask for a rebuild
  // (which clears lastFullSyncAt) between the caller's check and the claim.
  if (mode === "full" && (options.incrementalOnly || options.deferFullSync)) {
    await handBack();
    throw new FullSyncNotAllowedError("full_sync_needed");
  }

  // A sync cut off by the platform's time limit never reaches its own
  // error handling, so its record is still "in progress". Close it now.
  await prisma.syncRun.updateMany({
    where: { connectionId: connection.id, status: "in_progress", startedAt: { lt: new Date(Date.now() - STALE_SYNC_MINUTES * 60_000) } },
    data: { status: "error", finishedAt: new Date(), errorMessage: INTERRUPTED_MESSAGE },
  });
  // Read before this run's own SyncRun exists. Sync now (forceFull) always
  // reads everything afresh: a person pressing it wants what QuickBooks says
  // now, not steps read hours ago.
  let plan =
    mode === "full"
      ? await planFullSync(connection, {
          fresh: options.forceFull === true && options.resumeWithinMs == null,
          maxAgeMs: options.forceFull === true ? options.resumeWithinMs : undefined,
        })
      : null;
  // Too little time left in the caller's window for even the first step:
  // nothing is started (no run is recorded, so it isn't a try), and the
  // company is first in line for the next window (fullSyncContinueAt at the
  // epoch sorts first), where it starts at the beginning. Early in a window
  // it goes ahead regardless: no later run would have more time, and a step
  // that fits in no run at all ends up flagged (fullSyncStuck).
  if (plan != null && options.deadline != null) {
    const first = FULL_SYNC_STEPS.find((step) => !plan!.resume?.done.includes(step)) ?? FULL_SYNC_STEPS[0];
    const lateInWindow = Date.now() - (options.windowStart ?? calledAt) > WINDOW_START_SLACK_MS;
    if (lateInWindow && !fullSyncFirstStepFits(first, options.deadline, plan.stepMs)) {
      await handBack({ fullSyncContinueAt: new Date(0) });
      const remaining = FULL_SYNC_STEPS.filter((step) => !plan!.resume?.done.includes(step));
      return { ok: true, mode, unfinished: true, deferred: true, remaining };
    }
  }
  // Running out of time again and again: tried once a day from now on,
  // whatever happens to this run (the platform can stop it without a trace).
  const slowLane = plan != null && options.deadline != null && fullSyncStuck(plan.tries);
  if (slowLane) {
    await prisma.quickBooksConnection.update({
      where: { id: connection.id },
      data: { fullSyncContinueAt: new Date(Date.now() + DAY_MS), lastSyncError: FULL_SYNC_TOO_LONG_MESSAGE },
    });
  }
  const syncRun = await prisma.syncRun.create({
    data: { connectionId: connection.id, status: "in_progress", mode },
  });

  let counts: Record<string, any>;
  // The next incremental sync asks QuickBooks for changes since this sync
  // STARTED (less a small overlap), not since it finished: anything edited
  // while this one was running would otherwise fall in the gap until the
  // next full sync. Reprocessing a transaction twice is harmless. A full sync
  // over several runs started when its first run did.
  const syncStartedAt = plan?.resume ? new Date(plan.resume.startedAt) : new Date();
  let handedBack = false;
  try {
    const accessToken = await getValidAccessToken(connection);
    const realmId = decryptToken(connection.realmId);
    const ctx: SyncCtx = {
      connectionId: connection.id,
      realmId,
      accessToken,
      jobSource: jobSourceOf(connection.jobSource),
      // Checked again, atomically, at the moment of switching (see runFullSync).
      autoDetectSource: syncMayPickJobSource(connection),
      laborFromTimeEntries: connection.laborFromTimeEntries,
      startedAt: syncStartedAt,
      previousSyncAt: connection.lastSyncedAt,
    };

    let unfinished: FullSyncProgress | null = null;
    // Where the full sync has got to, after each step: the platform can stop
    // this run at its time limit without warning.
    const onStep = async (progress: FullSyncProgress, soFar: Record<string, any>) => {
      await prisma.syncRun.update({
        where: { id: syncRun.id },
        data: { entitiesUpdated: { ...soFar, fullSyncProgress: progress } as unknown as Prisma.InputJsonValue },
      });
    };
    if (mode === "full") {
      const part = await runFullSync(ctx, { deadline: options.deadline, resume: plan?.resume ?? null, history: plan?.stepMs ?? {}, onStep });
      counts = part.counts;
      unfinished = part.progress;
    } else {
      try {
        counts = await runIncrementalSync(
          ctx,
          new Date((connection.lastSyncedAt?.getTime() ?? 0) - CDC_OVERLAP_MS)
        );
      } catch (cdcErr) {
        if (isReconnectError(cdcErr)) throw cdcErr;
        // Recorded as a failed sync, which it is; the nightly sync retries it.
        if (options.incrementalOnly) throw new FullSyncNotAllowedError("change_feed_failed");
        if (options.deferFullSync) {
          // Nothing was written. The next nightly run does the full read in
          // its full-sync slot; until then the company shows as it was.
          await prisma.syncRun.update({
            where: { id: syncRun.id },
            data: { status: "error", finishedAt: new Date(), errorMessage: "Left for a full sync: QuickBooks' list of recent changes couldn't be read in full." },
          });
          await handBack({ fullSyncContinueAt: new Date() });
          handedBack = true;
          throw new FullSyncNotAllowedError("change_feed_failed");
        }
        // CDC itself failing is rare; a full read is the safe fallback.
        mode = "full";
        await prisma.syncRun.update({ where: { id: syncRun.id }, data: { mode } });
        plan = await planFullSync(connection, { fresh: true });
        const part = await runFullSync(ctx, { deadline: options.deadline, resume: null, history: plan.stepMs, onStep });
        counts = part.counts;
        unfinished = part.progress;
      }
    }

    // CompanyInfo is cheap and worth refreshing on every sync.
    try {
      const info = await qboCompanyInfo(realmId, accessToken);
      const companyName = info?.CompanyInfo?.CompanyName;
      if (companyName) {
        await prisma.quickBooksConnection.update({ where: { id: connection.id }, data: { companyName } });
      }
    } catch {
      // Non-fatal: the dashboard falls back to a generic label.
    }

    if (unfinished) {
      // Stopped partway, for want of time. Nothing about the company is
      // marked synced (lastSyncedAt, lastFullSyncAt and syncVersion wait for
      // the run that finishes), and the next nightly run carries on.
      const stoppedAt = new Date();
      const stuck = options.deadline != null && fullSyncStuck([...(plan?.tries ?? []), { status: "partial", errorMessage: null }]);
      await prisma.syncRun.update({
        where: { id: syncRun.id },
        data: {
          status: "partial",
          finishedAt: stoppedAt,
          entitiesUpdated: { ...counts, fullSyncProgress: unfinished } as unknown as Prisma.InputJsonValue,
        },
      });
      await prisma.quickBooksConnection.update({
        where: { id: connection.id },
        data: stuck
          ? {
              lastSyncStatus: "error",
              lastSyncError: FULL_SYNC_TOO_LONG_MESSAGE,
              lastSyncAttemptAt: stoppedAt,
              fullSyncContinueAt: new Date(stoppedAt.getTime() + DAY_MS),
            }
          : { lastSyncStatus: "success", lastSyncError: null, lastSyncAttemptAt: stoppedAt, fullSyncContinueAt: stoppedAt },
      });
      const remaining = FULL_SYNC_STEPS.filter((step) => !unfinished!.done.includes(step));
      return { ok: true, mode, unfinished: true, remaining, ...counts };
    }

    const now = new Date();
    await prisma.syncRun.update({
      where: { id: syncRun.id },
      data: { status: "success", finishedAt: now, entitiesUpdated: counts },
    });
    // A full sync only counts as done when nothing on it was cut short by
    // QuickBooks being briefly unavailable. Otherwise the next sync would
    // be incremental, which only reads records that change, and the type
    // that failed (time entries, say) would stay missing for up to 30 days.
    const partialErrors = (counts.partialErrors ?? {}) as Record<string, string>;
    const cutShort = Object.values(partialErrors).some((m) => /temporarily unavailable/i.test(String(m)));
    let recordFull = mode === "full";
    if (recordFull && cutShort) {
      // Retried as a full sync for up to a day, then accepted: a data
      // type that keeps failing mustn't make every nightly sync a full one.
      const since = (await prisma.quickBooksConnection.findUnique({ where: { id: connection.id }, select: { fullSyncCutShortAt: true } }))
        ?.fullSyncCutShortAt;
      if (!since) {
        await prisma.quickBooksConnection.update({ where: { id: connection.id }, data: { fullSyncCutShortAt: now } });
        recordFull = false;
      } else if (now.getTime() - since.getTime() < 86_400_000) {
        recordFull = false;
      }
    }
    // A full sync of a company stored under older rules for costs and revenue
    // can rewrite its figures without anything happening in QuickBooks.
    // Marked (as of the end of the rewrite) so the brief and alerts don't
    // report the difference as a change on the jobs, and only when figures
    // really moved: marking every upgrade would stop tracked pricing changes
    // and week-over-week comparisons for companies whose figures came out the
    // same. A version that only adds fields (invoice numbers, due dates)
    // changes no figures. Not on a company's first sync: nothing was stored.
    const rebuiltUnderNewRules =
      mode === "full" && connection.syncVersion < COST_SYNC_VERSION && connection.lastSyncedAt != null && rebuildChangedFigures(counts);
    await prisma.quickBooksConnection.update({
      where: { id: connection.id },
      data: {
        lastSyncedAt: syncStartedAt,
        lastSyncStatus: "success",
        lastSyncError: null,
        lastSyncAttemptAt: now,
        lastSyncEntitiesUpdated: counts,
        ...(rebuiltUnderNewRules ? { basisChangedAt: now } : {}),
      },
    });
    if (recordFull) {
      // Only if Settings hasn't asked for a rebuild since this sync started:
      // it read the old settings, so that rebuild must still happen.
      await prisma.quickBooksConnection.updateMany({
        where: {
          id: connection.id,
          OR: [{ rebuildRequestedAt: null }, { rebuildRequestedAt: { lt: syncStartedAt } }],
        },
        data: { lastFullSyncAt: now, syncVersion: SYNC_VERSION, fullSyncCutShortAt: null },
      });
    }
    if (mode === "full") {
      // Every step is done: nothing is owed any more, whether or not this
      // counts as the full sync (see recordFull).
      await prisma.quickBooksConnection.update({ where: { id: connection.id }, data: { fullSyncContinueAt: null } });
    }
  } catch (err) {
    if (handedBack) throw err;
    const message = err instanceof Error ? err.message : "Sync failed.";
    await prisma.syncRun.update({
      where: { id: syncRun.id },
      data: { status: "error", finishedAt: new Date(), errorMessage: message },
    });
    await prisma.quickBooksConnection.update({
      where: { id: connection.id },
      data: { lastSyncStatus: "error", lastSyncError: message, lastSyncAttemptAt: new Date() },
    });
    if (mode === "full") {
      // A full sync being carried on is retried a couple of hours later, like
      // any failed sync, not on the very next run (a day later if it's
      // already down to once a day).
      const retryAt = new Date(Date.now() + RETRY_FAILED_FULL_SYNC_MS);
      await prisma.quickBooksConnection.updateMany({
        where: { id: connection.id, fullSyncContinueAt: { not: null, lt: retryAt } },
        data: { fullSyncContinueAt: retryAt },
      });
    }
    throw err;
  }

  return { ok: true, mode, ...counts };
}

/**
 * Marks the connection as syncing, unless a sync is already running.
 * Atomic: two callers (the first-run setup and a cron, or two tabs) cannot
 * both win, which also stops two refreshes of the same QuickBooks refresh
 * token racing each other. A claim older than STALE_SYNC_MINUTES is treated
 * as a sync that died (a function timeout never reaches its catch block).
 */
async function claimSync(connectionId: string): Promise<boolean> {
  const staleBefore = new Date(Date.now() - STALE_SYNC_MINUTES * 60_000);
  const claimed = await prisma.quickBooksConnection.updateMany({
    where: {
      id: connectionId,
      OR: [
        { lastSyncStatus: null },
        { lastSyncStatus: { not: "in_progress" } },
        { lastSyncAttemptAt: null },
        { lastSyncAttemptAt: { lt: staleBefore } },
      ],
    },
    data: { lastSyncStatus: "in_progress", lastSyncAttemptAt: new Date() },
  });
  return claimed.count === 1;
}

/**
 * Runs `fn` with a working access token for a connection, outside a sync.
 * A still-valid token is used as is. A refresh takes the same claim a sync
 * does, so it can never race a running sync's refresh of the same token;
 * if a sync is running, this says so rather than waiting.
 */
export class SyncBusyError extends Error {
  constructor() {
    super("A sync is running for this company. Try again in a minute.");
    this.name = "SyncBusyError";
  }
}

export async function withAccessToken<T>(
  connectionId: string,
  fn: (realmId: string, accessToken: string) => Promise<T>
): Promise<T> {
  const c = await prisma.quickBooksConnection.findUnique({ where: { id: connectionId } });
  if (!c || c.disconnectedAt) throw new Error("This QuickBooks company isn't connected.");
  const realmId = decryptToken(c.realmId);
  if (c.accessTokenExpiresAt.getTime() - Date.now() > 5 * 60 * 1000) {
    return fn(realmId, decryptToken(c.accessToken));
  }
  if (!(await claimSync(connectionId))) throw new SyncBusyError();
  let token: string;
  try {
    token = await getValidAccessToken(c);
  } catch (err) {
    if (isReconnectError(err)) {
      await prisma.quickBooksConnection.update({
        where: { id: connectionId },
        data: { lastSyncStatus: "error", lastSyncError: (err as Error).message, lastSyncAttemptAt: new Date() },
      });
    } else {
      await prisma.quickBooksConnection
        .update({ where: { id: connectionId }, data: { lastSyncStatus: c.lastSyncStatus, lastSyncAttemptAt: c.lastSyncAttemptAt } })
        .catch(() => {});
    }
    throw err;
  }
  await prisma.quickBooksConnection.update({
    where: { id: connectionId },
    data: { lastSyncStatus: c.lastSyncStatus, lastSyncAttemptAt: c.lastSyncAttemptAt },
  });
  return fn(realmId, token);
}

/**
 * Asks QuickBooks whether a connection still works, without syncing. Used
 * by the Disconnect landing page: when someone disconnects the app from
 * inside QuickBooks, Intuit revokes the grant and sends them to us, and the
 * company should show as disconnected straight away rather than at the next
 * sync. Safe to call from a plain GET: it only records what Intuit reports.
 *
 * "revoked" marks the connection disconnected (its history is kept and
 * comes back on reconnect). "unknown" covers a sync already running and any
 * error that isn't Intuit refusing the grant.
 */
export async function probeConnection(connectionId: string): Promise<"ok" | "revoked" | "unknown"> {
  const before = await prisma.quickBooksConnection.findUnique({ where: { id: connectionId } });
  if (!before || before.disconnectedAt) return "unknown";
  if (!(await claimSync(connectionId))) return "unknown";
  const release = () =>
    prisma.quickBooksConnection.update({
      where: { id: connectionId },
      data: { lastSyncStatus: before.lastSyncStatus, lastSyncAttemptAt: before.lastSyncAttemptAt },
    });
  try {
    const accessToken = await getValidAccessToken(before);
    await qboCompanyInfo(decryptToken(before.realmId), accessToken);
    await release();
    return "ok";
  } catch (err) {
    if (isReconnectError(err)) {
      await prisma.quickBooksConnection.update({
        where: { id: connectionId },
        data: {
          disconnectedAt: new Date(),
          lastSyncStatus: "error",
          lastSyncError: err instanceof Error ? err.message : "Disconnected in QuickBooks.",
          lastSyncAttemptAt: new Date(),
        },
      });
      return "revoked";
    }
    await release().catch(() => {});
    return "unknown";
  }
}

function isReconnectError(err: unknown): boolean {
  return err instanceof Error && err.name === "ReconnectRequiredError";
}

// ---------------------------------------------------------------------------
// Shared context and state
// ---------------------------------------------------------------------------

interface SyncCtx {
  connectionId: string;
  realmId: string;
  accessToken: string;
  jobSource: JobSource;
  /**
   * First sync, with no job setup confirmed by the contractor: switch to
   * one customer per job when there are no projects. Classes are never
   * chosen automatically; the dashboard asks.
   */
  autoDetectSource: boolean;
  laborFromTimeEntries: boolean;
  startedAt: Date;
  /**
   * When the company's last finished sync started (its lastSyncedAt before
   * this sync). A transaction QuickBooks last changed before then was read
   * by that sync, so rows new on it now come from new rules, not new work
   * (see Writer.txnUnchangedSinceLastSync).
   */
  previousSyncAt?: Date | null;
  /**
   * Set by an incremental sync that gave a parent customer or class its
   * first job or a second one: costs tagged to the parent must move onto
   * the new job or back off the old one, which only a full sync does (see
   * parentsNeedingFullSync).
   */
  fullSyncNeeded?: boolean;
}

interface ExistingCost {
  id: string;
  jobId: string;
  amount: number;
  category: string;
  txnDate: number;
  description: string | null;
  attributionMethod: string;
  accountName: string | null;
  qboSourceType: string;
  qboSourceId: string;
  quantity: number | null;
}

interface ExistingRevenue {
  id: string;
  jobId: string;
  amount: number;
  taxAmount: number | null;
  status: string;
  txnDate: number;
  qboSourceType: string;
  qboInvoiceId: string;
  openBalance: number | null;
  docNumber: string | null;
  dueDate: number | null;
}

interface Tallies {
  untaggedJobCostCount: number;
  untaggedJobCostAmount: number;
  untaggedOverheadCount: number;
  untaggedOverheadAmount: number;
  unresolvedExpenseCount: number;
  unresolvedExpenseAmount: number;
  costsMatchedViaParentCount: number;
  costsMatchedViaParentAmount: number;
  timeEntriesWithoutPayRate: number;
  vendorTimeEntriesSkipped: number;
  unresolvedSamples: { source: string; txnId: string; customerId: string; customerName: string | null; amount: number }[];
}

const newTallies = (): Tallies => ({
  untaggedJobCostCount: 0,
  untaggedJobCostAmount: 0,
  untaggedOverheadCount: 0,
  untaggedOverheadAmount: 0,
  unresolvedExpenseCount: 0,
  unresolvedExpenseAmount: 0,
  costsMatchedViaParentCount: 0,
  costsMatchedViaParentAmount: 0,
  timeEntriesWithoutPayRate: 0,
  vendorTimeEntriesSkipped: 0,
  unresolvedSamples: [],
});

/**
 * Whether a row as this sync read it changes a job's figures, next to the row
 * stored: a different amount or a different job. A memo, an invoice number
 * or a due date filled in for the first time changes no job's figures.
 */
export function figuresDiffer(stored: { jobId: string; amount: number }, next: { jobId: string; amount: number }): boolean {
  return stored.jobId !== next.jobId || Math.abs(stored.amount - next.amount) >= 0.005;
}

/**
 * Whether a full sync changed any job's figures: stored rows given another
 * amount or job, rows added to a transaction that already had rows stored,
 * or rows removed. Counts from a sync that doesn't report figureRowsChanged
 * are taken to have changed them, the safe side for the brief and alerts.
 */
export function rebuildChangedFigures(counts: Record<string, any>): boolean {
  if (typeof counts.figureRowsChanged !== "number") return true;
  return counts.figureRowsChanged > 0 || Number(counts.costRowsRemoved ?? 0) > 0 || Number(counts.revenueRowsRemoved ?? 0) > 0;
}

/** Collects the writes a sync decides on, then applies them in bulk. */
class Writer {
  private costCreates: any[] = [];
  private revenueCreates: any[] = [];
  costUpdates = 0;
  revenueUpdates = 0;
  seenCost = new Set<string>();
  seenRevenue = new Set<string>();
  /**
   * Rows whose amount or job this sync changed, plus new rows on a
   * transaction that already had rows stored (a journal entry's credit line
   * read for the first time under new rules). See rebuildChangedFigures.
   */
  figureChanges = 0;
  /**
   * Set by the full sync for each transaction before it's processed: true
   * when QuickBooks last changed it before the last finished sync, so a row
   * new on it now comes from new rules (a supplier refund deposited to a
   * cost account, a refund check stored as revenue, rows put back after the
   * job setup changed), and counts as a figure change like a row new on a
   * transaction that had rows stored.
   */
  txnUnchangedSinceLastSync = false;
  private readonly storedTxns = new Set<string>();

  constructor(
    private readonly existingCost: Map<string, ExistingCost>,
    private readonly existingRevenue: Map<string, ExistingRevenue>
  ) {
    for (const r of existingCost.values()) this.storedTxns.add(`${r.qboSourceType}:${r.qboSourceId}`);
    for (const r of existingRevenue.values()) this.storedTxns.add(`${r.qboSourceType}:${r.qboInvoiceId}`);
  }

  async cost(row: {
    id: string;
    jobId: string;
    qboSourceType: string;
    qboSourceId: string;
    category: string;
    accountName: string | null;
    description: string | null;
    amount: number;
    txnDate: Date;
    attributionMethod: string;
    quantity?: number | null;
  }) {
    this.seenCost.add(row.id);
    const ex = this.existingCost.get(row.id);
    if (!ex) {
      if (this.txnUnchangedSinceLastSync || this.storedTxns.has(`${row.qboSourceType}:${row.qboSourceId}`)) this.figureChanges++;
      this.costCreates.push(row);
      if (this.costCreates.length >= 500) await this.flush();
      return;
    }
    if (figuresDiffer(ex, row)) this.figureChanges++;
    const changed =
      ex.jobId !== row.jobId ||
      Math.abs(ex.amount - row.amount) >= 0.005 ||
      ex.category !== row.category ||
      ex.txnDate !== row.txnDate.getTime() ||
      (ex.description ?? null) !== (row.description ?? null) ||
      ex.attributionMethod !== row.attributionMethod ||
      (ex.accountName ?? null) !== (row.accountName ?? null) ||
      (ex.quantity ?? null) !== (row.quantity ?? null);
    if (!changed) return;
    this.costUpdates++;
    await prisma.costEntry.update({
      where: { id: row.id },
      data: {
        jobId: row.jobId,
        category: row.category,
        accountName: row.accountName,
        description: row.description,
        amount: row.amount,
        txnDate: row.txnDate,
        attributionMethod: row.attributionMethod,
        quantity: row.quantity ?? null,
      },
    });
  }

  async revenue(row: {
    id: string;
    jobId: string;
    qboSourceType: string;
    qboInvoiceId: string;
    amount: number;
    taxAmount: number;
    status: string;
    txnDate: Date;
    openBalance?: number | null;
    docNumber?: string | null;
    dueDate?: Date | null;
  }) {
    this.seenRevenue.add(row.id);
    const ex = this.existingRevenue.get(row.id);
    if (!ex) {
      if (this.txnUnchangedSinceLastSync || this.storedTxns.has(`${row.qboSourceType}:${row.qboInvoiceId}`)) this.figureChanges++;
      this.revenueCreates.push(row);
      if (this.revenueCreates.length >= 500) await this.flush();
      return;
    }
    if (figuresDiffer(ex, row)) this.figureChanges++;
    const changed =
      ex.jobId !== row.jobId ||
      Math.abs(ex.amount - row.amount) >= 0.005 ||
      Math.abs((ex.taxAmount ?? 0) - row.taxAmount) >= 0.005 ||
      ex.status !== row.status ||
      ex.txnDate !== row.txnDate.getTime() ||
      (ex.openBalance ?? null) !== (row.openBalance ?? null) ||
      // Rows stored before these were kept get them on the next full sync.
      (ex.docNumber ?? null) !== (row.docNumber ?? null) ||
      (ex.dueDate ?? null) !== (row.dueDate?.getTime() ?? null);
    if (!changed) return;
    this.revenueUpdates++;
    await prisma.invoiceSummary.update({
      where: { id: row.id },
      data: {
        jobId: row.jobId,
        amount: row.amount,
        taxAmount: row.taxAmount,
        status: row.status,
        txnDate: row.txnDate,
        openBalance: row.openBalance ?? null,
        docNumber: row.docNumber ?? null,
        dueDate: row.dueDate ?? null,
      },
    });
  }

  async flush() {
    if (this.costCreates.length) {
      await prisma.costEntry.createMany({ data: this.costCreates, skipDuplicates: true });
      this.costCreates = [];
    }
    if (this.revenueCreates.length) {
      await prisma.invoiceSummary.createMany({ data: this.revenueCreates, skipDuplicates: true });
      this.revenueCreates = [];
    }
  }

  /** Existing cost rows of these source types that this sync did not see. */
  unseenCost(types: Set<string>, txnFilter?: (r: ExistingCost) => boolean): string[] {
    const out: string[] = [];
    for (const r of this.existingCost.values()) {
      if (!types.has(r.qboSourceType) || this.seenCost.has(r.id)) continue;
      if (txnFilter && !txnFilter(r)) continue;
      out.push(r.id);
    }
    return out;
  }

  unseenRevenue(types: Set<string>, txnFilter?: (r: ExistingRevenue) => boolean): string[] {
    const out: string[] = [];
    for (const r of this.existingRevenue.values()) {
      if (!types.has(r.qboSourceType) || this.seenRevenue.has(r.id)) continue;
      if (txnFilter && !txnFilter(r)) continue;
      out.push(r.id);
    }
    return out;
  }
}

async function deleteCostRows(ids: string[]): Promise<number> {
  let n = 0;
  for (let i = 0; i < ids.length; i += 500) {
    n += (await prisma.costEntry.deleteMany({ where: { id: { in: ids.slice(i, i + 500) } } })).count;
  }
  return n;
}

async function deleteRevenueRows(ids: string[]): Promise<number> {
  let n = 0;
  for (let i = 0; i < ids.length; i += 500) {
    n += (await prisma.invoiceSummary.deleteMany({ where: { id: { in: ids.slice(i, i + 500) } } })).count;
  }
  return n;
}

/**
 * Stored rows to diff against. For a full sync, all of them of the source
 * types in `onlyTypes` (each step of a full sync loads its own type); for an
 * incremental one, only those of the transactions in `onlyTxns` (source
 * type -> QuickBooks ids).
 */
async function loadExisting(connectionId: string, onlyTxns?: Map<string, string[]>, onlyTypes?: string[]) {
  // A journal entry can carry both cost and income lines, so its ids are
  // looked up on both sides.
  const costFilter = onlyTxns
    ? [...onlyTxns].filter(([t]) => COST_ROW_TYPES.has(t)).map(([t, ids]) => ({ qboSourceType: t, qboSourceId: { in: ids } }))
    : onlyTypes
      ? onlyTypes.filter((t) => COST_ROW_TYPES.has(t)).map((t) => ({ qboSourceType: t }))
      : null;
  const revenueFilter = onlyTxns
    ? [...onlyTxns].filter(([t]) => REVENUE_ROW_TYPES.has(t)).map(([t, ids]) => ({ qboSourceType: t, qboInvoiceId: { in: ids } }))
    : onlyTypes
      ? onlyTypes.filter((t) => REVENUE_ROW_TYPES.has(t)).map((t) => ({ qboSourceType: t }))
      : null;
  const [costRows, revenueRows] = await Promise.all([
    costFilter && costFilter.length === 0 ? Promise.resolve([]) : prisma.costEntry.findMany({
      where: { job: { connectionId }, ...(costFilter ? { OR: costFilter } : {}) },
      select: {
        id: true, jobId: true, amount: true, category: true, txnDate: true, description: true,
        attributionMethod: true, accountName: true, qboSourceType: true, qboSourceId: true, quantity: true,
      },
    }),
    revenueFilter && revenueFilter.length === 0 ? Promise.resolve([]) : prisma.invoiceSummary.findMany({
      where: { job: { connectionId }, ...(revenueFilter ? { OR: revenueFilter } : {}) },
      select: {
        id: true, jobId: true, amount: true, taxAmount: true, status: true, txnDate: true, qboSourceType: true, qboInvoiceId: true,
        openBalance: true, docNumber: true, dueDate: true,
      },
    }),
  ]);
  const existingCost = new Map<string, ExistingCost>();
  for (const r of costRows) {
    existingCost.set(r.id, { ...r, amount: Number(r.amount), txnDate: r.txnDate.getTime(), quantity: r.quantity == null ? null : Number(r.quantity) });
  }
  const existingRevenue = new Map<string, ExistingRevenue>();
  for (const r of revenueRows) {
    existingRevenue.set(r.id, {
      ...r,
      amount: Number(r.amount),
      taxAmount: r.taxAmount == null ? null : Number(r.taxAmount),
      txnDate: r.txnDate.getTime(),
      openBalance: r.openBalance == null ? null : Number(r.openBalance),
      dueDate: r.dueDate == null ? null : r.dueDate.getTime(),
    });
  }
  return { existingCost, existingRevenue };
}

// ---------------------------------------------------------------------------
// Lookups: accounts, items, the contractor's own category mappings
// ---------------------------------------------------------------------------

/**
 * The chart of accounts and product list decide which lines are job cost
 * and which category each lands in. Without them every bill would be
 * re-categorised and journal-entry costs would drop out, so a failure here
 * stops the sync before anything is written; the next one tries again.
 */
async function loadLookups(ctx: SyncCtx): Promise<Lookups> {
  const lookups = emptyLookups();
  const accounts = await qboQueryAll(ctx.realmId, ctx.accessToken, "SELECT * FROM Account WHERE Active IN (true, false)", "Account").catch(
    (err) => {
      if (isReconnectError(err)) throw err;
      throw new Error("Couldn't read your QuickBooks chart of accounts, so nothing was changed. The next sync will try again.");
    }
  );
  for (const a of accounts) {
    if (a?.Id == null) continue;
    const info: AccountInfo = {
      name: String(a.Name ?? ""),
      fullName: String(a.FullyQualifiedName ?? a.Name ?? ""),
      type: typeof a.AccountType === "string" ? a.AccountType : null,
      subType: typeof a.AccountSubType === "string" ? a.AccountSubType : null,
    };
    lookups.accounts.set(String(a.Id), info);
  }
  const items = await qboQueryAll(ctx.realmId, ctx.accessToken, "SELECT * FROM Item WHERE Active IN (true, false)", "Item").catch(
    (err) => {
      if (isReconnectError(err)) throw err;
      throw new Error("Couldn't read your QuickBooks products and services, so nothing was changed. The next sync will try again.");
    }
  );
  for (const it of items) {
    if (it?.Id == null) continue;
    const info: ItemInfo = {
      name: String(it.FullyQualifiedName ?? it.Name ?? ""),
      expenseAccountId: it.ExpenseAccountRef?.value != null ? String(it.ExpenseAccountRef.value) : null,
      purchaseCost: Number.isFinite(Number(it.PurchaseCost)) && Number(it.PurchaseCost) > 0 ? Number(it.PurchaseCost) : null,
    };
    lookups.items.set(String(it.Id), info);
  }
  const mappings = await prisma.categoryMapping.findMany({ where: { connectionId: ctx.connectionId } });
  for (const m of mappings) lookups.mappings.set(m.sourceName, m.category);
  return lookups;
}

/**
 * Runs one entity's fetch in isolation, so one failing entity type can't
 * take the whole sync down with it. Failures are recorded by entity name
 * in the sync result, and a type that failed is never swept (its stored
 * rows are left alone rather than deleted for "not being returned").
 */
async function runStep<T>(label: string, errors: Record<string, string>, fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (isReconnectError(err)) throw err;
    errors[label] = err instanceof Error ? err.message : "Unknown error";
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

/** How long a job with the contractor's own entries is kept after it stops appearing in QuickBooks. */
const MISSING_JOB_GRACE_MS = 3 * 86_400_000;

function hasManualData(j: {
  estimatedCost: unknown;
  manualContractValue: unknown;
  percentCompleteOverride: unknown;
  category: string | null;
  statusOverride: string | null;
}): boolean {
  return (
    j.estimatedCost != null ||
    j.manualContractValue != null ||
    j.percentCompleteOverride != null ||
    j.category != null ||
    j.statusOverride != null
  );
}

/**
 * `fullList`: `customers` is every customer in the company (a full sync).
 * `allowRemoval`: that list is known to be complete, so jobs missing from
 * it may be removed.
 */
async function upsertJobs(
  ctx: SyncCtx,
  customers: any[],
  fullList: boolean,
  allowRemoval = false,
  /** Class mode: picks the jobs, given the class jobs already stored; customers is ignored then. */
  precomputed?: (existingIds: Set<string>) => JobCandidate[]
): Promise<number> {
  const nameById = new Map<string, string>();
  if (fullList) {
    for (const c of customers) if (c?.Id != null && typeof c.DisplayName === "string") nameById.set(String(c.Id), c.DisplayName);
  }
  const existing = await prisma.job.findMany({
    where: { connectionId: ctx.connectionId },
    select: {
      id: true, qboId: true, parentQboId: true, customerName: true, name: true, status: true, qboCreatedAt: true,
      missingSince: true, estimatedCost: true, manualContractValue: true, percentCompleteOverride: true,
      category: true, statusOverride: true,
    },
  });
  const byQboId = new Map(existing.map((j) => [j.qboId, j]));
  const existingIds = new Set(existing.map((j) => j.qboId));
  // An incremental sync sees only the customers that changed, so "has no
  // sub-customers" can't be judged from that list alone. A customer that is
  // already the parent of a stored job is a client, not a job, unless it is
  // itself a job already (see keepIds in selectJobCustomers).
  const knownParents = new Set(existing.map((j) => j.parentQboId).filter((v): v is string => Boolean(v)));
  const candidates = (
    precomputed?.(existingIds) ??
    selectJobCustomers(
      customers,
      ctx.jobSource,
      fullList ? nameById : undefined,
      ctx.jobSource === "customers" ? existingIds : undefined
    )
  ).filter((c) => fullList || ctx.jobSource === "projects" || !knownParents.has(c.qboId) || existingIds.has(c.qboId));

  // A full sync re-matches every cost itself; an incremental one only reads
  // what changed, so it asks for a full sync when costs tagged to a parent
  // now belong on a different job: the parent's first job (costs tagged to
  // the customer before the project existed), or its second (costs that were
  // on its only job). A parent customer created since the last sync is left
  // out: every transaction naming it is in this sync's changes, matched
  // against the new job below, so a full sync would find nothing to move.
  if (!fullList) {
    const live = existing.filter((j) => j.missingSince == null);
    if (parentsNeedingFullSync(live, candidates).length > 0) {
      const last = await prisma.quickBooksConnection.findUnique({ where: { id: ctx.connectionId }, select: { lastSyncedAt: true } });
      // The same point the change list was read from (see runSyncForConnection).
      const changedSince = last?.lastSyncedAt ? new Date(last.lastSyncedAt.getTime() - CDC_OVERLAP_MS) : null;
      if (parentsNeedingFullSync(live, candidates, customersCreatedSince(customers, changedSince)).length > 0) ctx.fullSyncNeeded = true;
    }
  }

  for (const c of candidates) {
    const status = c.active ? "open" : "closed";
    const ex = byQboId.get(c.qboId);
    if (!ex) {
      await prisma.job.create({
        data: {
          connectionId: ctx.connectionId,
          qboId: c.qboId,
          parentQboId: c.parentQboId,
          customerName: c.customerName,
          name: c.name,
          status,
          qboCreatedAt: c.createdAt,
        },
      });
      continue;
    }
    const changed =
      ex.missingSince != null ||
      ex.parentQboId !== c.parentQboId ||
      (c.customerName != null && ex.customerName !== c.customerName) ||
      ex.name !== c.name ||
      ex.status !== status ||
      (c.createdAt != null && ex.qboCreatedAt?.getTime() !== c.createdAt.getTime());
    if (!changed) continue;
    await prisma.job.update({
      where: { id: ex.id },
      data: {
        parentQboId: c.parentQboId,
        // Only written when resolved: an incremental sync that cannot see
        // the parent must not blank a name a full sync already got right.
        ...(c.customerName ? { customerName: c.customerName } : {}),
        name: c.name,
        status,
        missingSince: null,
        ...(c.createdAt ? { qboCreatedAt: c.createdAt } : {}),
      },
    });
  }
  // Never on an empty list: a QuickBooks response with no customers at all
  // is far likelier to be a glitch than a company with none, and deleting
  // every job would take the contractor's own estimates with it.
  // Nor on a list that came back shorter than QuickBooks says it should be
  // (allowRemoval is false then).
  if (fullList && allowRemoval && candidates.length > 0) {
    // Jobs that no longer are jobs: the contractor switched between
    // Projects and one-customer-per-job in Settings, or the customer was
    // deleted in QuickBooks. A job with nothing typed into it here is
    // removed with its rows; the costs and revenue are re-read below
    // against the jobs that do exist. A job with the contractor's own
    // entries is hidden first and removed only if it is still missing a
    // few days later.
    const keep = new Set(candidates.map((c) => c.qboId));
    const now = ctx.startedAt.getTime();
    const missing = existing.filter((j) => !keep.has(j.qboId));
    const gone = missing
      .filter((j) => !hasManualData(j) || (j.missingSince != null && now - j.missingSince.getTime() > MISSING_JOB_GRACE_MS))
      .map((j) => j.id);
    const hide = missing.filter((j) => hasManualData(j) && j.missingSince == null).map((j) => j.id);
    for (let i = 0; i < gone.length; i += 500) {
      await prisma.job.deleteMany({ where: { id: { in: gone.slice(i, i + 500) }, connectionId: ctx.connectionId } });
    }
    for (let i = 0; i < hide.length; i += 500) {
      await prisma.job.updateMany({
        where: { id: { in: hide.slice(i, i + 500) }, connectionId: ctx.connectionId },
        data: { missingSince: ctx.startedAt },
      });
    }
  }
  return candidates.length;
}

async function loadJobIndex(connectionId: string): Promise<JobIndex> {
  // A job that has gone missing from QuickBooks gets no transactions: they
  // belong to whatever the customer is now (a project under it, say).
  const jobs = await prisma.job.findMany({
    where: { connectionId, missingSince: null },
    select: { id: true, qboId: true, parentQboId: true },
  });
  return buildJobIndex(jobs);
}

// ---------------------------------------------------------------------------
// Transaction processing (shared by full and incremental)
// ---------------------------------------------------------------------------

interface Processor {
  ctx: SyncCtx;
  lookups: Lookups;
  index: JobIndex;
  writer: Writer;
  tallies: Tallies;
  windowStart: number;
  /** Each untagged job-cost line the tallies count, for Data Health's fix list. */
  untagged: UntaggedCostCollector;
}

/**
 * The key a transaction line is matched to a job by: its customer, or in
 * class mode its Class. Null when the line has neither, which counts as
 * untagged.
 */
function jobKey(p: Processor, customerQboId: string | null, classQboId: string | null): string | null {
  if (p.ctx.jobSource === "classes") return classQboId ? classJobKey(classQboId) : null;
  return customerQboId;
}

function inWindow(p: Processor, date: Date | null): boolean {
  return date != null && date.getTime() >= p.windowStart;
}

function noteUnresolved(p: Processor, source: string, txnId: string, customerId: string, customerName: string | null, amount: number, date: Date | null) {
  if (!inWindow(p, date)) return;
  p.tallies.unresolvedExpenseCount++;
  p.tallies.unresolvedExpenseAmount += amount;
  if (p.tallies.unresolvedSamples.length < 5) {
    p.tallies.unresolvedSamples.push({ source, txnId, customerId, customerName, amount });
  }
}

async function processExpenseTxn(p: Processor, txn: any, sourceType: ExpenseSourceType) {
  if (txn?.Id == null) return;
  const txnId = String(txn.Id);
  const txnDate = qboDate(txn.TxnDate);
  if (!txnDate) return;
  for (const line of expenseLines(txn, sourceType, p.lookups)) {
    const key = jobKey(p, line.customerQboId, line.classQboId);
    if (!key) {
      if (!inWindow(p, txnDate)) continue;
      // Journal entries without a customer are usually company-wide
      // postings (a payroll summary, an allocation), not a job cost someone
      // forgot to tag, so they count with overhead (see isUntaggedJobCost).
      if (isUntaggedJobCost(line, sourceType)) {
        p.tallies.untaggedJobCostCount++;
        p.tallies.untaggedJobCostAmount += line.amount;
        p.untagged.add(sourceType, txn, line, txnDate);
      } else {
        p.tallies.untaggedOverheadCount++;
        p.tallies.untaggedOverheadAmount += line.amount;
      }
      continue;
    }
    const resolved = resolveJob(p.index, key);
    if (!resolved) {
      noteUnresolved(p, sourceType, txnId, key, line.customerName, line.amount, txnDate);
      continue;
    }
    if (resolved.method === "parent_customer_fallback") {
      p.tallies.costsMatchedViaParentCount++;
      p.tallies.costsMatchedViaParentAmount += line.amount;
    }
    await p.writer.cost({
      id: costEntryId(p.ctx.connectionId, sourceType, txnId, line.lineId),
      jobId: resolved.jobId,
      qboSourceType: sourceType,
      qboSourceId: txnId,
      category: line.category,
      accountName: line.accountName,
      description: line.description,
      amount: line.amount,
      txnDate,
      attributionMethod: resolved.method,
    });
  }
}

async function processTimeActivity(p: Processor, ta: any) {
  if (ta?.Id == null) return;
  const txnId = String(ta.Id);
  const txnDate = qboDate(ta.TxnDate);
  if (!txnDate) return;
  const result = timeActivityCost(ta, p.ctx.jobSource);
  if (result.kind === "skip") {
    if (result.reason === "no_pay_rate" && inWindow(p, txnDate)) p.tallies.timeEntriesWithoutPayRate++;
    if (result.reason === "vendor_time") p.tallies.vendorTimeEntriesSkipped++;
    return;
  }
  const customerId = ta.CustomerRef?.value != null ? String(ta.CustomerRef.value) : null;
  const classId = ta.ClassRef?.value != null ? String(ta.ClassRef.value) : null;
  const key = jobKey(p, customerId, classId);
  if (!key) return;
  const resolved = resolveJob(p.index, key);
  if (!resolved) {
    noteUnresolved(p, "TimeActivity", txnId, key, ta.CustomerRef?.name ?? null, result.amount, txnDate);
    return;
  }
  if (resolved.method === "parent_customer_fallback") {
    p.tallies.costsMatchedViaParentCount++;
    p.tallies.costsMatchedViaParentAmount += result.amount;
  }
  // Hours and who, never the cost rate: the job page is not the place to
  // publish what each employee earns.
  const who = ta.EmployeeRef?.name ? `${ta.EmployeeRef.name}, ` : "";
  await p.writer.cost({
    id: costEntryId(p.ctx.connectionId, "TimeActivity", txnId, 0),
    jobId: resolved.jobId,
    qboSourceType: "TimeActivity",
    qboSourceId: txnId,
    category: result.category,
    accountName: "Time entries (cost rate)",
    description: ta.Description ?? `${who}${round2(result.hours)} h`,
    amount: result.amount,
    txnDate,
    attributionMethod: resolved.method,
    quantity: round2(result.hours),
  });
}

async function processRevenueTxn(p: Processor, txn: any, sourceType: RevenueSourceType) {
  const r = revenueFromTxn(txn, sourceType);
  if (!r.txnDate) return;
  if (p.ctx.jobSource === "classes") {
    // One row per class on the sale: a single invoice can bill two jobs.
    for (const part of revenueByClass(txn, sourceType)) {
      if (!part.classQboId) continue;
      const resolved = resolveJob(p.index, classJobKey(part.classQboId));
      if (!resolved) continue;
      await p.writer.revenue({
        id: `${revenueId(p.ctx.connectionId, sourceType, String(txn.Id))}:${classJobKey(part.classQboId)}`,
        jobId: resolved.jobId,
        qboSourceType: sourceType,
        qboInvoiceId: String(txn.Id),
        amount: part.amount,
        taxAmount: part.tax,
        status: r.status,
        txnDate: r.txnDate,
        openBalance: part.openBalance,
        docNumber: part.docNumber,
        dueDate: part.dueDate,
      });
    }
    return;
  }
  if (!r.customerQboId) return;
  const resolved = resolveJob(p.index, r.customerQboId);
  if (!resolved) return;
  await p.writer.revenue({
    id: revenueId(p.ctx.connectionId, sourceType, String(txn.Id)),
    jobId: resolved.jobId,
    qboSourceType: sourceType,
    qboInvoiceId: String(txn.Id),
    amount: r.amount,
    taxAmount: r.tax,
    status: r.status,
    txnDate: r.txnDate,
    openBalance: r.openBalance,
    docNumber: r.docNumber,
    dueDate: r.dueDate,
  });
}

/**
 * Income recorded line by line without an invoice: bank deposits, journal
 * entries, and income lines on checks, bills and vendor credits (a refund
 * paid to a customer, which is negative).
 */
async function processLineRevenue(p: Processor, txn: any, sourceType: LineRevenueSourceType) {
  if (txn?.Id == null) return;
  const txnId = String(txn.Id);
  const byClass = p.ctx.jobSource === "classes";
  const lines =
    sourceType === "Deposit"
      ? depositRevenueLines(txn, p.lookups, byClass)
      : sourceType === "JournalEntry"
        ? journalRevenueLines(txn, p.lookups, byClass)
        : expenseRevenueLines(txn, sourceType, p.lookups, byClass);
  for (const l of lines) {
    if (!l.txnDate) continue;
    const key = jobKey(p, l.customerQboId, l.classQboId);
    if (!key) continue;
    const resolved = resolveJob(p.index, key);
    if (!resolved) continue;
    await p.writer.revenue({
      id: lineRevenueId(p.ctx.connectionId, sourceType, txnId, l.lineId),
      jobId: resolved.jobId,
      qboSourceType: sourceType,
      qboInvoiceId: txnId,
      amount: l.amount,
      taxAmount: 0,
      status: "paid",
      txnDate: l.txnDate,
    });
  }
}

/**
 * Supplier refunds and other money deposited back against a cost account
 * for a job: stored as negative cost rows. A line that names no job is left
 * alone here (it isn't a cost that was missed, so it isn't counted as
 * untagged either).
 */
async function processDepositCosts(p: Processor, txn: any) {
  if (txn?.Id == null) return;
  const txnId = String(txn.Id);
  const txnDate = qboDate(txn.TxnDate);
  if (!txnDate) return;
  for (const line of depositCostLines(txn, p.lookups)) {
    const key = jobKey(p, line.customerQboId, line.classQboId);
    if (!key) continue;
    const resolved = resolveJob(p.index, key);
    if (!resolved) {
      noteUnresolved(p, "Deposit", txnId, key, line.customerName, line.amount, txnDate);
      continue;
    }
    if (resolved.method === "parent_customer_fallback") {
      p.tallies.costsMatchedViaParentCount++;
      p.tallies.costsMatchedViaParentAmount += line.amount;
    }
    await p.writer.cost({
      id: costEntryId(p.ctx.connectionId, "Deposit", txnId, line.lineId),
      jobId: resolved.jobId,
      qboSourceType: "Deposit",
      qboSourceId: txnId,
      category: line.category,
      accountName: line.accountName,
      description: line.description,
      amount: line.amount,
      txnDate,
      attributionMethod: resolved.method,
    });
  }
}

// ---------------------------------------------------------------------------
// Estimates -> contract value
// ---------------------------------------------------------------------------

function sameLines(stored: unknown, next: { n: string | null; c: string; a: number; q?: number | null; u?: number | null; qa?: number | null }[]): boolean {
  if (!Array.isArray(stored) || stored.length !== next.length) return false;
  const same = (x: unknown, y: number | null | undefined) =>
    (x == null && y == null) || (x != null && y != null && Math.abs(Number(x) - y) < 0.005);
  return stored.every(
    (l: any, i) =>
      l?.n === next[i].n &&
      l?.c === next[i].c &&
      Math.abs(Number(l?.a) - next[i].a) < 0.005 &&
      same(l?.q, next[i].q) &&
      same(l?.u, next[i].u) &&
      same(l?.qa, next[i].qa)
  );
}

async function applyEstimates(ctx: SyncCtx, estimates: any[], full: boolean, lookups: Lookups): Promise<void> {
  const touchedCustomers = new Set<string>();
  const existing = await prisma.jobEstimate.findMany({ where: { connectionId: ctx.connectionId } });
  const existingById = new Map(existing.map((e) => [e.id, e]));
  const seen = new Set<string>();

  for (const est of estimates) {
    if (est?.Id == null) continue;
    const id = estimateRowId(ctx.connectionId, String(est.Id));
    const prior = existingById.get(id);
    if (est.status === "Deleted") {
      if (prior) {
        touchedCustomers.add(prior.customerQboId);
        await prisma.jobEstimate.delete({ where: { id } });
      }
      continue;
    }
    const parsed = estimateFromTxn(est, lookups);
    const { record, details } = parsed;
    // In class mode an estimate belongs to its class's job; one with no
    // class is kept under its customer, where it attaches to nothing.
    const customerQboId =
      ctx.jobSource === "classes" && parsed.classQboId ? classJobKey(parsed.classQboId) : parsed.customerQboId;
    if (!customerQboId || !record) continue;
    seen.add(id);
    touchedCustomers.add(customerQboId);
    if (prior) touchedCustomers.add(prior.customerQboId);
    const data = {
      connectionId: ctx.connectionId,
      qboEstimateId: String(est.Id),
      customerQboId,
      amount: record.amount,
      status: record.status,
      txnDate: record.txnDate,
      docNumber: details.docNumber,
      customerName: details.customerName,
      emailStatus: details.emailStatus,
      expirationDate: details.expirationDate,
      lines: details.lines as unknown as Prisma.InputJsonValue,
    };
    const unchanged =
      prior &&
      prior.customerQboId === data.customerQboId &&
      Math.abs(Number(prior.amount) - data.amount) < 0.005 &&
      prior.status === data.status &&
      prior.txnDate.getTime() === data.txnDate.getTime() &&
      prior.docNumber === data.docNumber &&
      prior.customerName === data.customerName &&
      prior.emailStatus === data.emailStatus &&
      (prior.expirationDate?.getTime() ?? null) === (data.expirationDate?.getTime() ?? null) &&
      // Compared field by field: Postgres returns JSON objects with their
      // keys in its own order, so the raw JSON never matches.
      sameLines(prior.lines, details.lines);
    if (unchanged) continue;
    await prisma.jobEstimate.upsert({ where: { id }, create: { id, ...data }, update: data });
  }

  if (full) {
    const gone = existing.filter((e) => !seen.has(e.id));
    for (const e of gone) touchedCustomers.add(e.customerQboId);
    if (gone.length) await prisma.jobEstimate.deleteMany({ where: { id: { in: gone.map((e) => e.id) } } });
  }

  // Recompute every job the changed estimates can affect, from all of that
  // job's estimates rather than from just the ones in this batch.
  const index = await loadJobIndex(ctx.connectionId);
  const all = await prisma.jobEstimate.findMany({ where: { connectionId: ctx.connectionId } });
  const byJob = new Map<string, { amount: number; status: string; txnDate: Date }[]>();
  for (const e of all) {
    const resolved = resolveJob(index, e.customerQboId);
    if (!resolved) continue;
    byJob.set(resolved.jobId, [...(byJob.get(resolved.jobId) ?? []), { amount: Number(e.amount), status: e.status, txnDate: e.txnDate }]);
  }
  const affectedJobs = new Set<string>();
  if (full) {
    for (const id of index.byQboId.values()) affectedJobs.add(id);
  } else {
    for (const c of touchedCustomers) {
      const r = resolveJob(index, c);
      if (r) affectedJobs.add(r.jobId);
    }
  }
  const current = await prisma.job.findMany({
    where: { id: { in: [...affectedJobs] } },
    select: { id: true, estimatedRevenue: true },
  });
  for (const job of current) {
    const value = contractValueFromEstimates(byJob.get(job.id) ?? []);
    const now = job.estimatedRevenue == null ? null : Number(job.estimatedRevenue);
    if (value === now || (value != null && now != null && Math.abs(value - now) < 0.005)) continue;
    await prisma.job.update({ where: { id: job.id }, data: { estimatedRevenue: value } });
  }
}

// ---------------------------------------------------------------------------
// Full sync
// ---------------------------------------------------------------------------

interface FullSyncPlan {
  /** Where an earlier run of this full sync got to, or null to start from the first step. */
  resume: FullSyncProgress | null;
  /** How long each step took in the last finished full sync. */
  stepMs: Record<string, number>;
  /** This full sync's earlier runs that didn't finish it (see fullSyncStuck). */
  tries: { status: string; errorMessage: string | null }[];
}

/** What a full sync carries on from, and how it has gone so far. Read before this run's SyncRun is created. */
async function planFullSync(
  connection: { id: string; jobSource: string | null; laborFromTimeEntries: boolean; rebuildRequestedAt: Date | null; lastSyncedAt: Date | null },
  opts: { fresh: boolean; maxAgeMs?: number }
): Promise<FullSyncPlan> {
  const lastFinished = await prisma.syncRun.findFirst({
    where: { connectionId: connection.id, mode: "full", status: "success" },
    orderBy: { startedAt: "desc" },
    select: { startedAt: true, entitiesUpdated: true },
  });
  const timed = (lastFinished?.entitiesUpdated as Record<string, any> | null)?.stepMs;
  const stepMs: Record<string, number> = {};
  if (timed && typeof timed === "object") {
    for (const [step, ms] of Object.entries(timed)) if (typeof ms === "number" && Number.isFinite(ms)) stepMs[step] = ms;
  }

  // The newest run that got anywhere: carried on from, unless it finished.
  // One that stopped partway, failed, or was stopped by the platform keeps
  // the progress of the steps it finished (see onStep below); one that
  // failed before finishing a step has none and is passed over.
  let stored: unknown = null;
  let storedRunFinishedAt: Date | null = null;
  if (!opts.fresh) {
    const recent = await prisma.syncRun.findMany({
      where: { connectionId: connection.id, mode: "full", status: { in: ["partial", "success", "error"] } },
      orderBy: { startedAt: "desc" },
      take: 10,
      select: { status: true, entitiesUpdated: true, finishedAt: true },
    });
    for (const run of recent) {
      if (run.status === "success") break;
      const progress = (run.entitiesUpdated as Record<string, any> | null)?.fullSyncProgress;
      if (progress) {
        stored = progress;
        storedRunFinishedAt = run.finishedAt ?? null;
        break;
      }
    }
  }
  let resume = usableFullSyncProgress(stored, connection);
  // maxAgeMs (Sync now's resumeWithinMs) counts from when the progress was
  // last saved, not from when the whole read began: a press an hour into a
  // read that's still moving carries on with it.
  if (resume && opts.maxAgeMs != null) {
    const saved = Date.parse(resume.savedAt ?? "");
    const lastMoved = Number.isFinite(saved) ? saved : storedRunFinishedAt?.getTime() ?? Date.parse(resume.startedAt);
    if (Date.now() - lastMoved > opts.maxAgeMs) resume = null;
  }
  // The latest timings: this read's own (how long its lookups take now)
  // over the last finished full sync's.
  if (resume) Object.assign(stepMs, resume.stepMs);

  // Runs since the last finished full sync, or since Settings asked for a
  // rebuild, which starts the count again.
  let since = lastFinished?.startedAt ?? null;
  if (connection.rebuildRequestedAt && (!since || connection.rebuildRequestedAt > since)) since = connection.rebuildRequestedAt;
  const tries = await prisma.syncRun.findMany({
    where: { connectionId: connection.id, mode: "full", ...(since ? { startedAt: { gt: since } } : {}) },
    select: { status: true, errorMessage: true },
  });
  return { resume, stepMs, tries };
}

/**
 * Reads the company's whole QuickBooks history, one step at a time (see
 * FULL_SYNC_STEPS). Each step reads its type in full, then brings the stored
 * rows of that type exactly in step with it, removing what QuickBooks no
 * longer returns.
 *
 * With a deadline it stops before a step that wouldn't finish in time, and
 * returns its progress for the next run to carry on from (`resume`). Every
 * run does at least one step, so each makes progress. `onStep` is handed the
 * progress after each step, so a run the platform stops at its time limit
 * still leaves the steps it finished for the next run.
 */
async function runFullSync(
  ctx: SyncCtx,
  opts: {
    deadline?: number;
    resume?: FullSyncProgress | null;
    history?: Record<string, number>;
    onStep?: (progress: FullSyncProgress, counts: Record<string, any>) => Promise<void>;
  } = {}
): Promise<{ counts: Record<string, any>; progress: FullSyncProgress | null }> {
  const resume = opts.resume ?? null;
  const done = new Set(resume?.done ?? []);
  // A step whose type QuickBooks failed to send is done too, as it was when
  // a full sync was a single run: its stored rows are kept, and the error
  // decides below whether this counts as the full sync (see recordFull).
  const errors: Record<string, string> = { ...(resume?.errors ?? {}) };
  const fetched: Record<string, number> = { ...(resume?.fetched ?? {}) };
  const stepMs: Record<string, number> = { ...(resume?.stepMs ?? {}) };
  const totals: SyncTotals = { ...emptyTotals(), ...(resume?.totals ?? {}) };
  let jobCount = resume?.jobs ?? 0;

  const lookupsStarted = Date.now();
  const lookups = await loadLookups(ctx);
  // Timed like a step, so a run can tell whether its first step fits (see fullSyncFirstStepFits).
  stepMs.Lookups = Date.now() - lookupsStarted;
  const tallies = newTallies();
  const p: Processor = {
    ctx,
    lookups,
    // Set once the jobs are known: by the Jobs step, or below when an earlier run did it.
    index: null as unknown as JobIndex,
    writer: new Writer(new Map(), new Map()),
    tallies,
    windowStart: ctx.startedAt.getTime() - COUNTER_WINDOW_DAYS * 86_400_000,
    untagged: new UntaggedCostCollector(ctx.connectionId),
  };
  if (done.has("Jobs")) p.index = await loadJobIndex(ctx.connectionId);

  /** Reads one type's stored rows, then keeps them exactly in step with what QuickBooks sent. */
  const syncType = async (type: string, rows: any[], process: (txn: any) => Promise<void>, sweep: { cost: boolean; revenue: boolean }) => {
    const { existingCost, existingRevenue } = await loadExisting(ctx.connectionId, undefined, [type]);
    const writer = new Writer(existingCost, existingRevenue);
    p.writer = writer;
    const since = ctx.previousSyncAt?.getTime();
    for (const txn of rows) {
      // No LastUpdatedTime: taken as unchanged, the safe side for the brief
      // and alerts (see rebuildChangedFigures).
      const updated = Date.parse(txn?.MetaData?.LastUpdatedTime ?? "");
      writer.txnUnchangedSinceLastSync = since != null && (!Number.isFinite(updated) || updated < since);
      await process(txn);
    }
    writer.txnUnchangedSinceLastSync = false;
    await writer.flush();
    // Everything stored for this type that QuickBooks no longer returns:
    // deleted transactions, voided ones, lines moved to a job-less customer,
    // and rows stored under the previous id scheme.
    const only = new Set([type]);
    if (sweep.cost) totals.costRowsRemoved += await deleteCostRows(writer.unseenCost(only));
    if (sweep.revenue) totals.revenueRowsRemoved += await deleteRevenueRows(writer.unseenRevenue(only));
    totals.costRowsWritten += writer.seenCost.size;
    totals.costRowsUpdated += writer.costUpdates;
    totals.revenueRowsUpdated += writer.revenueUpdates;
    totals.figureRowsChanged += writer.figureChanges;
    // Data Health's list of job costs not on any job: this type's rows
    // become what this read found. Other types keep theirs until read.
    if ((EXPENSE_TYPES as string[]).includes(type)) {
      await replaceUntaggedCosts(
        ctx.connectionId,
        p.untagged.rows().filter((r) => r.qboSourceType === type),
        FULL_SYNC_STEPS.filter((s) => s !== type)
      );
    }
  };
  const read = (type: string) => qboQueryAll(ctx.realmId, ctx.accessToken, `SELECT * FROM ${type}`, type);
  const readOrNote = (type: string) => runStep(type, errors, () => read(type), null as any[] | null);

  const steps: Record<string, () => Promise<void>> = {
    Jobs: async () => {
      jobCount = await syncJobs(ctx);
      p.index = await loadJobIndex(ctx.connectionId);
    },
    TimeActivity: async () => {
      if (!ctx.laborFromTimeEntries) {
        // Turned off in Settings: every stored time-based cost goes.
        await syncType("TimeActivity", [], async () => {}, { cost: true, revenue: false });
        return;
      }
      const rows = await readOrNote("TimeActivity");
      if (rows == null) return;
      fetched.TimeActivity = rows.length;
      await syncType("TimeActivity", rows, (ta) => processTimeActivity(p, ta), { cost: true, revenue: false });
    },
    Deposit: async () => {
      const rows = await readOrNote("Deposit");
      if (rows == null) return;
      fetched.Deposit = rows.length;
      await syncType(
        "Deposit",
        rows,
        async (txn) => {
          await processLineRevenue(p, txn, "Deposit");
          await processDepositCosts(p, txn);
        },
        { cost: true, revenue: true }
      );
    },
    Estimate: async () => {
      const rows = await readOrNote("Estimate");
      if (rows == null) return;
      fetched.Estimate = rows.length;
      await applyEstimates(ctx, rows, true, lookups);
    },
  };
  // Purchase is the backbone of job costing, and Invoice of revenue: if
  // either can't be read, the sync genuinely failed and says so.
  for (const type of EXPENSE_TYPES) {
    steps[type] = async () => {
      const rows = type === "Purchase" ? await read(type) : await readOrNote(type);
      if (rows == null) return;
      fetched[type] = rows.length;
      await syncType(
        type,
        rows,
        async (txn) => {
          await processExpenseTxn(p, txn, type);
          // Income lines on the same transaction: a journal entry's, or a
          // refund check to a customer.
          await processLineRevenue(p, txn, type);
        },
        { cost: true, revenue: true }
      );
    };
  }
  for (const type of REVENUE_TYPES) {
    steps[type] = async () => {
      const rows = type === "Invoice" ? await read(type) : await readOrNote(type);
      if (rows == null) return;
      fetched[type] = rows.length;
      await syncType(type, rows, (txn) => processRevenueTxn(p, txn, type), { cost: false, revenue: true });
    };
  }

  const counts = (): Record<string, any> => {
    const parts = (resume?.parts ?? 0) + 1;
    return {
      jobs: jobCount,
      jobSource: ctx.jobSource,
      ...fetched,
      purchases: fetched.Purchase ?? 0,
      bills: fetched.Bill ?? 0,
      timeActivities: fetched.TimeActivity ?? 0,
      invoices: fetched.Invoice ?? 0,
      estimates: fetched.Estimate ?? 0,
      costRowsWritten: totals.costRowsWritten,
      costRowsUpdated: totals.costRowsUpdated,
      costRowsRemoved: totals.costRowsRemoved,
      revenueRowsUpdated: totals.revenueRowsUpdated,
      revenueRowsRemoved: totals.revenueRowsRemoved,
      // Read by rebuildChangedFigures: whether this sync changed job figures.
      figureRowsChanged: totals.figureRowsChanged,
      countersWindowDays: COUNTER_WINDOW_DAYS,
      ...roundTallies(resume ? addTallies(resume.tallies, tallies) : tallies),
      // How long each step took, so the next full sync knows what fits in its time.
      stepMs: { ...stepMs },
      ...(parts > 1 ? { fullSyncRuns: parts } : {}),
      ...(Object.keys(errors).length > 0 ? { partialErrors: { ...errors } } : {}),
    };
  };
  const progress = (): FullSyncProgress => ({
    startedAt: ctx.startedAt.toISOString(),
    version: SYNC_VERSION,
    jobSource: ctx.jobSource,
    laborFromTimeEntries: ctx.laborFromTimeEntries,
    done: FULL_SYNC_STEPS.filter((s) => done.has(s)),
    parts: (resume?.parts ?? 0) + 1,
    jobs: jobCount,
    fetched: { ...fetched },
    tallies: resume ? addTallies(resume.tallies, tallies) : { ...tallies, unresolvedSamples: [...tallies.unresolvedSamples] },
    totals: { ...totals },
    errors: { ...errors },
    stepMs: { ...stepMs },
    savedAt: new Date().toISOString(),
  });

  let ranOne = false;
  for (const step of FULL_SYNC_STEPS) {
    if (done.has(step)) continue;
    if (ranOne && !fullSyncStepFits(step, opts.deadline, opts.history ?? {})) break;
    const started = Date.now();
    await steps[step]();
    stepMs[step] = Date.now() - started;
    done.add(step);
    ranOne = true;
    if (opts.onStep && FULL_SYNC_STEPS.some((s) => !done.has(s))) await opts.onStep(progress(), counts());
  }

  const finished = FULL_SYNC_STEPS.every((s) => done.has(s));
  return { counts: counts(), progress: finished ? null : progress() };
}

/** A full sync's first step: every job, from the customer list or the class list. Returns how many there are. */
async function syncJobs(ctx: SyncCtx): Promise<number> {
  // SELECT * (composite fields such as ParentRef and Line come back empty
  // when named in a column list) and inactive records too: QuickBooks'
  // query endpoint returns only active records unless asked, and making a
  // customer inactive is how many contractors mark a job finished.
  // Paging has no guaranteed order, so a record added or changed mid-read
  // can shift a page and drop one. Only a list at least as long as
  // QuickBooks' own count is trusted to remove jobs.
  const listIsComplete = async (entity: string, got: number) => {
    try {
      const counted = await qboQuery(ctx.realmId, ctx.accessToken, `SELECT COUNT(*) FROM ${entity} WHERE Active IN (true, false)`);
      const total = Number(counted?.QueryResponse?.totalCount);
      return Number.isFinite(total) && got >= total;
    } catch (err) {
      if (isReconnectError(err)) throw err;
      return false;
    }
  };

  if (ctx.jobSource === "classes") {
    // Each QuickBooks Class is a job (sub-classes, when a class has them).
    const allClasses = await qboQueryAll(ctx.realmId, ctx.accessToken, "SELECT * FROM Class WHERE Active IN (true, false)", "Class");
    if (allClasses.length === 0) {
      // Nothing is changed: the jobs stay as they were until the setting is fixed.
      throw new Error(
        "Your jobs are set to come from QuickBooks Classes, but QuickBooks sent no classes. If your jobs aren't classes, change how your jobs are set up in Settings."
      );
    }
    const complete = await listIsComplete("Class", allClasses.length);
    return upsertJobs(ctx, [], true, complete, (keep) => selectJobClasses(allClasses, keep));
  }
  const allCustomers = await qboQueryAll(ctx.realmId, ctx.accessToken, "SELECT * FROM Customer WHERE Active IN (true, false)", "Customer");
  const customerListComplete = await listIsComplete("Customer", allCustomers.length);
  if (ctx.autoDetectSource && ctx.jobSource === "projects" && !allCustomers.some((c: any) => c?.Job === true) && allCustomers.length > 0) {
    // No projects or sub-customers at all: this contractor makes one
    // customer per job. Recorded so Settings shows it and can change it.
    // (A company that tracks jobs by Class is asked on the dashboard,
    // since classes are just as often used for divisions or phases.)
    // Only while nothing has been confirmed: a choice made in Settings
    // since this sync started wins, and this sync's rows are rebuilt by
    // the full sync that choice asked for.
    const switched = await prisma.quickBooksConnection.updateMany({
      where: { id: ctx.connectionId, jobSource: "projects", jobSourceConfirmedAt: null },
      data: { jobSource: "customers" },
    });
    if (switched.count === 1) ctx.jobSource = "customers";
  }
  return upsertJobs(ctx, allCustomers, true, customerListComplete);
}

function roundTallies(t: Tallies) {
  return {
    ...t,
    untaggedJobCostAmount: round2(t.untaggedJobCostAmount),
    untaggedOverheadAmount: round2(t.untaggedOverheadAmount),
    unresolvedExpenseAmount: round2(t.unresolvedExpenseAmount),
    costsMatchedViaParentAmount: round2(t.costsMatchedViaParentAmount),
  };
}

// ---------------------------------------------------------------------------
// Incremental sync (Change Data Capture)
// ---------------------------------------------------------------------------

/**
 * Makes the next sync a full one, for a reason that is not a change of
 * basis: QuickBooks itself changed in a way only a full read can follow.
 *
 * Clearing lastFullSyncAt is what makes a sync full. It is not a Settings
 * rebuild, so rebuildRequestedAt isn't set; a finished rebuild's request
 * date is cleared instead, because with lastFullSyncAt empty it would read as
 * a rebuild still waiting, which the brief and alerts treat as a change of
 * basis (rebuildPending in weekOverWeek.ts). A rebuild that really is still
 * waiting already makes the next sync full, so it is left alone.
 */
async function requestFullSync(connectionId: string): Promise<void> {
  const c = await prisma.quickBooksConnection.findUnique({
    where: { id: connectionId },
    select: { rebuildRequestedAt: true, lastFullSyncAt: true },
  });
  if (!c) return;
  const rebuildWaiting = c.rebuildRequestedAt != null && (c.lastFullSyncAt == null || c.lastFullSyncAt < c.rebuildRequestedAt);
  if (rebuildWaiting) return;
  await prisma.quickBooksConnection.updateMany({
    // Unless Settings asked for a rebuild in the meantime, which does the same.
    where: { id: connectionId, rebuildRequestedAt: c.rebuildRequestedAt },
    data: { lastFullSyncAt: null, rebuildRequestedAt: null },
  });
}

async function runIncrementalSync(ctx: SyncCtx, changedSince: Date): Promise<Record<string, any>> {
  const errors: Record<string, string> = {};
  const entities = cdcEntitiesFor(ctx.jobSource);
  const cdc = await qboCdc(ctx.realmId, ctx.accessToken, entities, changedSince);
  const responses: any[] = cdc?.CDCResponse?.[0]?.QueryResponse ?? [];
  const byEntity = (name: string): any[] => {
    const match = responses.find((r) => Array.isArray(r?.[name]));
    return match?.[name] ?? [];
  };

  // QuickBooks caps each entity at 1,000 changed records per call and says
  // nothing about the rest. A capped list can't be trusted to be complete,
  // so the caller falls back to a full sync (see runSyncForConnection).
  // Checked across all entities together, in case the cap applies to the
  // whole response rather than to each type.
  const cdcTotal = entities.reduce((sum, name) => sum + byEntity(name).length, 0);
  if (cdcTotal >= CDC_MAX_PER_ENTITY) throw new Error(`Change Data Capture returned ${cdcTotal} records, at or over its cap`);

  const lookups = await loadLookups(ctx);
  const jobCount =
    ctx.jobSource === "classes"
      ? await upsertJobs(ctx, [], false, false, (keep) => selectJobClasses(byEntity("Class").filter((c) => c?.status !== "Deleted"), keep))
      : await upsertJobs(ctx, byEntity("Customer").filter((c) => c?.status !== "Deleted"), false);
  const index = await loadJobIndex(ctx.connectionId);

  // Only the stored rows of the transactions that changed are loaded:
  // everything else is left exactly as it is, and a nightly sync doesn't
  // read a company's whole history to update a handful of bills.
  const changedIds = new Map<string, string[]>();
  for (const type of [...EXPENSE_TYPES, "TimeActivity", ...REVENUE_TYPES, "Deposit"]) {
    const ids = byEntity(type).filter((t) => t?.Id != null).map((t) => String(t.Id));
    if (ids.length) changedIds.set(type, ids);
  }
  const { existingCost, existingRevenue } = await loadExisting(ctx.connectionId, changedIds);
  const writer = new Writer(existingCost, existingRevenue);
  const tallies = newTallies();
  const p: Processor = {
    ctx, lookups, index, writer, tallies, windowStart: ctx.startedAt.getTime() - COUNTER_WINDOW_DAYS * 86_400_000,
    untagged: new UntaggedCostCollector(ctx.connectionId),
  };

  // Every transaction CDC reports is re-read in full, so for each one the
  // stored rows can be made to match exactly: lines added, changed, moved
  // or removed (a void zeroes every line), or the whole thing deleted.
  const touchedCost = new Map<string, Set<string>>(); // source type -> txn ids
  const touchedRevenue = new Map<string, Set<string>>();
  const touch = (m: Map<string, Set<string>>, type: string, id: string) => m.set(type, (m.get(type) ?? new Set()).add(id));
  const counts: Record<string, number> = {};

  for (const type of EXPENSE_TYPES) {
    const rows = byEntity(type);
    counts[type] = rows.length;
    for (const txn of rows) {
      if (txn?.Id == null) continue;
      touch(touchedCost, type, String(txn.Id));
      // Every expense type can carry income lines too (see processLineRevenue).
      touch(touchedRevenue, type, String(txn.Id));
      if (txn.status !== "Deleted") {
        await processExpenseTxn(p, txn, type);
        await processLineRevenue(p, txn, type);
      }
    }
  }
  const times = ctx.laborFromTimeEntries ? byEntity("TimeActivity") : [];
  counts.TimeActivity = times.length;
  for (const ta of times) {
    if (ta?.Id == null) continue;
    touch(touchedCost, "TimeActivity", String(ta.Id));
    if (ta.status !== "Deleted") await processTimeActivity(p, ta);
  }
  for (const type of REVENUE_TYPES) {
    const rows = byEntity(type);
    counts[type] = rows.length;
    for (const txn of rows) {
      if (txn?.Id == null) continue;
      touch(touchedRevenue, type, String(txn.Id));
      if (txn.status !== "Deleted") await processRevenueTxn(p, txn, type);
    }
  }
  const depositRows = byEntity("Deposit");
  counts.Deposit = depositRows.length;
  for (const txn of depositRows) {
    if (txn?.Id == null) continue;
    touch(touchedRevenue, "Deposit", String(txn.Id));
    touch(touchedCost, "Deposit", String(txn.Id));
    if (txn.status !== "Deleted") {
      await processLineRevenue(p, txn, "Deposit");
      await processDepositCosts(p, txn);
    }
  }
  await writer.flush();

  const costTypes = new Set(touchedCost.keys());
  const removedCosts = await deleteCostRows(
    writer.unseenCost(costTypes, (r) => touchedCost.get(r.qboSourceType)?.has(r.qboSourceId) ?? false)
  );
  const revenueTypes = new Set(touchedRevenue.keys());
  const removedRevenue = await deleteRevenueRows(
    writer.unseenRevenue(revenueTypes, (r) => touchedRevenue.get(r.qboSourceType)?.has(r.qboInvoiceId) ?? false)
  );
  // Same for the list of job costs not on any job: each re-read transaction's
  // lines are replaced, which drops the ones now on a job and deleted ones.
  await replaceUntaggedCostsForTxns(ctx.connectionId, p.untagged.rows(), touchedCost);

  const estimates = byEntity("Estimate");
  counts.Estimate = estimates.length;
  if (estimates.length) await applyEstimates(ctx, estimates, false, lookups);

  // A parent customer or class gained its first job or a second one: the
  // next sync is a full one, so costs tagged to the parent move onto the new
  // job, or back off its former only job, within a day, not 30.
  if (ctx.fullSyncNeeded) await requestFullSync(ctx.connectionId);

  return {
    jobs: jobCount,
    jobSource: ctx.jobSource,
    ...(ctx.fullSyncNeeded ? { fullSyncRequested: true } : {}),
    ...counts,
    purchases: counts.Purchase ?? 0,
    bills: counts.Bill ?? 0,
    timeActivities: counts.TimeActivity ?? 0,
    invoices: counts.Invoice ?? 0,
    estimates: counts.Estimate ?? 0,
    costRowsUpdated: writer.costUpdates,
    costRowsRemoved: removedCosts,
    revenueRowsUpdated: writer.revenueUpdates,
    revenueRowsRemoved: removedRevenue,
    ...(Object.keys(errors).length > 0 ? { partialErrors: errors } : {}),
  };
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

// Module-private on purpose: nothing outside this module should be able to
// obtain a decrypted customer access token.
async function getValidAccessToken(connection: {
  id: string;
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: Date;
}): Promise<string> {
  // Refresh a little early (5 min buffer) rather than racing the exact expiry.
  const stillValid = connection.accessTokenExpiresAt.getTime() - Date.now() > 5 * 60 * 1000;
  if (stillValid) return decryptToken(connection.accessToken);

  const refreshed = await refreshTokens(decryptToken(connection.refreshToken));
  const now = Date.now();

  await prisma.quickBooksConnection.update({
    where: { id: connection.id },
    data: {
      accessToken: encryptToken(refreshed.access_token),
      refreshToken: encryptToken(refreshed.refresh_token),
      accessTokenExpiresAt: new Date(now + refreshed.expires_in * 1000),
      refreshTokenExpiresAt: new Date(now + refreshed.x_refresh_token_expires_in * 1000),
    },
  });

  return refreshed.access_token;
}
