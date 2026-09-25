import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { qboQuery, qboQueryAll, qboCompanyInfo, qboCdc, refreshTokens } from "@/lib/quickbooks";
import { encryptToken, decryptToken } from "@/lib/crypto";
import {
  buildJobIndex,
  contractValueFromEstimates,
  costEntryId,
  emptyLookups,
  estimateFromTxn,
  estimateRowId,
  expenseLines,
  qboDate,
  resolveJob,
  revenueFromTxn,
  revenueId,
  round2,
  selectJobCustomers,
  timeActivityCost,
  type AccountInfo,
  type ExpenseSourceType,
  type ItemInfo,
  type JobIndex,
  type JobSource,
  type Lookups,
  type RevenueSourceType,
} from "@/lib/qboNormalize";

/**
 * The QuickBooks sync engine: reads a connection's job-costing data from
 * QuickBooks and writes it into Job / CostEntry / InvoiceSummary /
 * JobEstimate, so every page and the weekly brief run on local data.
 *
 * Called by POST /api/quickbooks/sync (a person clicking Sync now), by the
 * nightly sync cron and by the weekly-email cron. Callers decide whether the
 * caller may sync this connection; this module only does the work.
 *
 * What a payload MEANS (bill rate vs pay rate, refunds, tax, which
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
 * 2: row ids include the connection id; labor at pay rate; refunds,
 *    vendor credits, sales receipts, credit memos, journal entries; tax
 *    removed from revenue; deletions honoured.
 * 3: estimate lines, numbers, email status and expiry dates, for the
 *    Estimate Check and estimate accuracy by cost category.
 */
export const SYNC_VERSION = 3;

/**
 * The last version that changed how COSTS and REVENUE are stored. The weekly
 * brief waits for a company's upgrade sync only below this, because only
 * those upgrades can make figures read wrong mid-way. Version 3 only adds
 * estimate details, so a brief never waits on it.
 */
export const COST_SYNC_VERSION = 2;

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
const CDC_ENTITIES = ["Customer", ...EXPENSE_TYPES, "TimeActivity", ...REVENUE_TYPES, "Estimate"];

export class SyncAlreadyRunningError extends Error {
  constructor() {
    super("A QuickBooks sync is already running for this company. Give it a minute and refresh.");
    this.name = "SyncAlreadyRunningError";
  }
}

export async function runSyncForConnection(
  connectionId: string,
  options: { forceFull?: boolean } = {}
): Promise<Record<string, any>> {
  if (!(await claimSync(connectionId))) throw new SyncAlreadyRunningError();
  // Read after taking the claim, so the refresh token is the one the last
  // sync left behind, not one it rotated a moment ago.
  const connection = await prisma.quickBooksConnection.findUniqueOrThrow({ where: { id: connectionId } });

  const fullSyncDue =
    !connection.lastFullSyncAt ||
    Date.now() - connection.lastFullSyncAt.getTime() > FULL_SYNC_INTERVAL_DAYS * 86_400_000;
  // forceFull exists because an incremental sync cannot repair anything: it
  // only sees what QuickBooks says changed. The same goes for a connection
  // stored under an older version of these rules.
  let mode: "full" | "incremental" =
    options.forceFull || fullSyncDue || connection.syncVersion < SYNC_VERSION ? "full" : "incremental";

  const syncRun = await prisma.syncRun.create({
    data: { connectionId: connection.id, status: "in_progress", mode },
  });

  let counts: Record<string, any>;
  // The next incremental sync asks QuickBooks for changes since this sync
  // STARTED (less a small overlap), not since it finished: anything edited
  // while this one was running would otherwise fall in the gap until the
  // next full sync. Reprocessing a transaction twice is harmless.
  const syncStartedAt = new Date();
  try {
    const accessToken = await getValidAccessToken(connection);
    const realmId = decryptToken(connection.realmId);
    const ctx: SyncCtx = {
      connectionId: connection.id,
      realmId,
      accessToken,
      jobSource: (connection.jobSource === "customers" ? "customers" : "projects") as JobSource,
      autoDetectSource: !connection.lastSyncedAt,
      laborFromTimeEntries: connection.laborFromTimeEntries,
      startedAt: syncStartedAt,
    };

    if (mode === "full") {
      counts = await runFullSync(ctx);
    } else {
      try {
        counts = await runIncrementalSync(
          ctx,
          new Date((connection.lastSyncedAt?.getTime() ?? 0) - CDC_OVERLAP_MS)
        );
      } catch (cdcErr) {
        if (isReconnectError(cdcErr)) throw cdcErr;
        // CDC itself failing is rare; a full read is the safe fallback.
        mode = "full";
        await prisma.syncRun.update({ where: { id: syncRun.id }, data: { mode } });
        counts = await runFullSync(ctx);
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

    const now = new Date();
    await prisma.syncRun.update({
      where: { id: syncRun.id },
      data: { status: "success", finishedAt: now, entitiesUpdated: counts },
    });
    await prisma.quickBooksConnection.update({
      where: { id: connection.id },
      data: {
        lastSyncedAt: syncStartedAt,
        lastSyncStatus: "success",
        lastSyncError: null,
        lastSyncAttemptAt: now,
        lastSyncEntitiesUpdated: counts,
        ...(mode === "full" ? { lastFullSyncAt: now, syncVersion: SYNC_VERSION } : {}),
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Sync failed.";
    await prisma.syncRun.update({
      where: { id: syncRun.id },
      data: { status: "error", finishedAt: new Date(), errorMessage: message },
    });
    await prisma.quickBooksConnection.update({
      where: { id: connection.id },
      data: { lastSyncStatus: "error", lastSyncError: message, lastSyncAttemptAt: new Date() },
    });
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
  /** First sync: switch to one-customer-per-job when there are no projects. */
  autoDetectSource: boolean;
  laborFromTimeEntries: boolean;
  startedAt: Date;
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

/** Collects the writes a sync decides on, then applies them in bulk. */
class Writer {
  private costCreates: any[] = [];
  private revenueCreates: any[] = [];
  costUpdates = 0;
  revenueUpdates = 0;
  seenCost = new Set<string>();
  seenRevenue = new Set<string>();

  constructor(
    private readonly existingCost: Map<string, ExistingCost>,
    private readonly existingRevenue: Map<string, ExistingRevenue>
  ) {}

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
  }) {
    this.seenCost.add(row.id);
    const ex = this.existingCost.get(row.id);
    if (!ex) {
      this.costCreates.push(row);
      if (this.costCreates.length >= 500) await this.flush();
      return;
    }
    const changed =
      ex.jobId !== row.jobId ||
      Math.abs(ex.amount - row.amount) >= 0.005 ||
      ex.category !== row.category ||
      ex.txnDate !== row.txnDate.getTime() ||
      (ex.description ?? null) !== (row.description ?? null) ||
      ex.attributionMethod !== row.attributionMethod ||
      (ex.accountName ?? null) !== (row.accountName ?? null);
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
  }) {
    this.seenRevenue.add(row.id);
    const ex = this.existingRevenue.get(row.id);
    if (!ex) {
      this.revenueCreates.push(row);
      if (this.revenueCreates.length >= 500) await this.flush();
      return;
    }
    const changed =
      ex.jobId !== row.jobId ||
      Math.abs(ex.amount - row.amount) >= 0.005 ||
      Math.abs((ex.taxAmount ?? 0) - row.taxAmount) >= 0.005 ||
      ex.status !== row.status ||
      ex.txnDate !== row.txnDate.getTime();
    if (!changed) return;
    this.revenueUpdates++;
    await prisma.invoiceSummary.update({
      where: { id: row.id },
      data: { jobId: row.jobId, amount: row.amount, taxAmount: row.taxAmount, status: row.status, txnDate: row.txnDate },
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
 * Stored rows to diff against. All of them for a full sync; for an
 * incremental one, only those of the transactions in `onlyTxns` (source
 * type -> QuickBooks ids).
 */
async function loadExisting(connectionId: string, onlyTxns?: Map<string, string[]>) {
  const revenueTypes = new Set<string>(REVENUE_TYPES);
  const costFilter = onlyTxns
    ? [...onlyTxns].filter(([t]) => !revenueTypes.has(t)).map(([t, ids]) => ({ qboSourceType: t, qboSourceId: { in: ids } }))
    : null;
  const revenueFilter = onlyTxns
    ? [...onlyTxns].filter(([t]) => revenueTypes.has(t)).map(([t, ids]) => ({ qboSourceType: t, qboInvoiceId: { in: ids } }))
    : null;
  const [costRows, revenueRows] = await Promise.all([
    costFilter && costFilter.length === 0 ? Promise.resolve([]) : prisma.costEntry.findMany({
      where: { job: { connectionId }, ...(costFilter ? { OR: costFilter } : {}) },
      select: {
        id: true, jobId: true, amount: true, category: true, txnDate: true, description: true,
        attributionMethod: true, accountName: true, qboSourceType: true, qboSourceId: true,
      },
    }),
    revenueFilter && revenueFilter.length === 0 ? Promise.resolve([]) : prisma.invoiceSummary.findMany({
      where: { job: { connectionId }, ...(revenueFilter ? { OR: revenueFilter } : {}) },
      select: { id: true, jobId: true, amount: true, taxAmount: true, status: true, txnDate: true, qboSourceType: true, qboInvoiceId: true },
    }),
  ]);
  const existingCost = new Map<string, ExistingCost>();
  for (const r of costRows) {
    existingCost.set(r.id, { ...r, amount: Number(r.amount), txnDate: r.txnDate.getTime() });
  }
  const existingRevenue = new Map<string, ExistingRevenue>();
  for (const r of revenueRows) {
    existingRevenue.set(r.id, {
      ...r,
      amount: Number(r.amount),
      taxAmount: r.taxAmount == null ? null : Number(r.taxAmount),
      txnDate: r.txnDate.getTime(),
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
async function upsertJobs(ctx: SyncCtx, customers: any[], fullList: boolean, allowRemoval = false): Promise<number> {
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
  const candidates = selectJobCustomers(
    customers,
    ctx.jobSource,
    fullList ? nameById : undefined,
    ctx.jobSource === "customers" ? existingIds : undefined
  ).filter((c) => fullList || ctx.jobSource === "projects" || !knownParents.has(c.qboId) || existingIds.has(c.qboId));

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
    if (!line.customerQboId) {
      if (!inWindow(p, txnDate)) continue;
      // Journal entries without a customer are usually company-wide
      // postings (a payroll summary, an allocation), not a job cost someone
      // forgot to tag, so they count with overhead.
      if (line.isJobCostAccount && sourceType !== "JournalEntry") {
        p.tallies.untaggedJobCostCount++;
        p.tallies.untaggedJobCostAmount += line.amount;
      } else {
        p.tallies.untaggedOverheadCount++;
        p.tallies.untaggedOverheadAmount += line.amount;
      }
      continue;
    }
    const resolved = resolveJob(p.index, line.customerQboId);
    if (!resolved) {
      noteUnresolved(p, sourceType, txnId, line.customerQboId, line.customerName, line.amount, txnDate);
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
  const result = timeActivityCost(ta);
  if (result.kind === "skip") {
    if (result.reason === "no_pay_rate" && inWindow(p, txnDate)) p.tallies.timeEntriesWithoutPayRate++;
    if (result.reason === "vendor_time") p.tallies.vendorTimeEntriesSkipped++;
    return;
  }
  const customerId = String(ta.CustomerRef.value);
  const resolved = resolveJob(p.index, customerId);
  if (!resolved) {
    noteUnresolved(p, "TimeActivity", txnId, customerId, ta.CustomerRef?.name ?? null, result.amount, txnDate);
    return;
  }
  if (resolved.method === "parent_customer_fallback") {
    p.tallies.costsMatchedViaParentCount++;
    p.tallies.costsMatchedViaParentAmount += result.amount;
  }
  // Hours and who, never the pay rate: the job page is not the place to
  // publish what each employee earns.
  const who = ta.EmployeeRef?.name ? `${ta.EmployeeRef.name}, ` : "";
  await p.writer.cost({
    id: costEntryId(p.ctx.connectionId, "TimeActivity", txnId, 0),
    jobId: resolved.jobId,
    qboSourceType: "TimeActivity",
    qboSourceId: txnId,
    category: result.category,
    accountName: "Time entries (pay rate)",
    description: ta.Description ?? `${who}${round2(result.hours)} h`,
    amount: result.amount,
    txnDate,
    attributionMethod: resolved.method,
  });
}

async function processRevenueTxn(p: Processor, txn: any, sourceType: RevenueSourceType) {
  const r = revenueFromTxn(txn, sourceType);
  if (!r.customerQboId || !r.txnDate) return;
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
  });
}

// ---------------------------------------------------------------------------
// Estimates -> contract value
// ---------------------------------------------------------------------------

function sameLines(stored: unknown, next: { n: string | null; c: string; a: number }[]): boolean {
  if (!Array.isArray(stored) || stored.length !== next.length) return false;
  return stored.every((l: any, i) => l?.n === next[i].n && l?.c === next[i].c && Math.abs(Number(l?.a) - next[i].a) < 0.005);
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
    const { customerQboId, record, details } = estimateFromTxn(est, lookups);
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

async function runFullSync(ctx: SyncCtx): Promise<Record<string, any>> {
  const errors: Record<string, string> = {};
  const lookups = await loadLookups(ctx);

  // SELECT * (composite fields such as ParentRef and Line come back empty
  // when named in a column list) and inactive records too: QuickBooks'
  // query endpoint returns only active records unless asked, and making a
  // customer inactive is how many contractors mark a job finished.
  const allCustomers = await qboQueryAll(ctx.realmId, ctx.accessToken, "SELECT * FROM Customer WHERE Active IN (true, false)", "Customer");
  // Paging has no guaranteed order, so a customer added or changed mid-read
  // can shift a page and drop a record. Only a list at least as long as
  // QuickBooks' own count is trusted to remove jobs.
  let customerListComplete = false;
  try {
    const counted = await qboQuery(ctx.realmId, ctx.accessToken, "SELECT COUNT(*) FROM Customer WHERE Active IN (true, false)");
    const total = Number(counted?.QueryResponse?.totalCount);
    customerListComplete = Number.isFinite(total) && allCustomers.length >= total;
  } catch (err) {
    if (isReconnectError(err)) throw err;
  }

  if (ctx.autoDetectSource && ctx.jobSource === "projects" && !allCustomers.some((c: any) => c?.Job === true) && allCustomers.length > 0) {
    // No projects or sub-customers at all: this contractor makes one
    // customer per job. Recorded so Settings shows it and can change it.
    ctx.jobSource = "customers";
    await prisma.quickBooksConnection.update({ where: { id: ctx.connectionId }, data: { jobSource: "customers" } });
  }
  const jobCount = await upsertJobs(ctx, allCustomers, true, customerListComplete);
  const index = await loadJobIndex(ctx.connectionId);

  const { existingCost, existingRevenue } = await loadExisting(ctx.connectionId);
  const writer = new Writer(existingCost, existingRevenue);
  const tallies = newTallies();
  const p: Processor = { ctx, lookups, index, writer, tallies, windowStart: ctx.startedAt.getTime() - COUNTER_WINDOW_DAYS * 86_400_000 };
  const fetched: Record<string, number> = {};
  const sweepCost = new Set<string>();
  const sweepRevenue = new Set<string>();

  // Purchase is the backbone of job costing: if it cannot be read, the
  // sync genuinely failed and says so.
  for (const type of EXPENSE_TYPES) {
    const query = `SELECT * FROM ${type}`;
    const rows = type === "Purchase"
      ? await qboQueryAll(ctx.realmId, ctx.accessToken, query, type)
      : await runStep(type, errors, () => qboQueryAll(ctx.realmId, ctx.accessToken, query, type), null as any[] | null);
    if (rows == null) continue;
    fetched[type] = rows.length;
    for (const txn of rows) await processExpenseTxn(p, txn, type);
    sweepCost.add(type);
  }

  if (ctx.laborFromTimeEntries) {
    const rows = await runStep("TimeActivity", errors, () =>
      qboQueryAll(ctx.realmId, ctx.accessToken, "SELECT * FROM TimeActivity", "TimeActivity"), null as any[] | null);
    if (rows != null) {
      fetched.TimeActivity = rows.length;
      for (const ta of rows) await processTimeActivity(p, ta);
      sweepCost.add("TimeActivity");
    }
  } else {
    // Turned off in Settings: every stored time-based cost goes.
    sweepCost.add("TimeActivity");
  }

  for (const type of REVENUE_TYPES) {
    const query = `SELECT * FROM ${type}`;
    const rows = type === "Invoice"
      ? await qboQueryAll(ctx.realmId, ctx.accessToken, query, type)
      : await runStep(type, errors, () => qboQueryAll(ctx.realmId, ctx.accessToken, query, type), null as any[] | null);
    if (rows == null) continue;
    fetched[type] = rows.length;
    for (const txn of rows) await processRevenueTxn(p, txn, type);
    sweepRevenue.add(type);
  }

  await writer.flush();

  // Everything stored for a successfully read type that QuickBooks no
  // longer returns: deleted transactions, voided ones, lines moved to a
  // job-less customer, and rows stored under the previous id scheme.
  const removedCosts = await deleteCostRows(writer.unseenCost(sweepCost));
  const removedRevenue = await deleteRevenueRows(writer.unseenRevenue(sweepRevenue));

  const estimates = await runStep("Estimate", errors, () =>
    qboQueryAll(ctx.realmId, ctx.accessToken, "SELECT * FROM Estimate", "Estimate"), null as any[] | null);
  if (estimates != null) {
    fetched.Estimate = estimates.length;
    await applyEstimates(ctx, estimates, true, lookups);
  }

  return {
    jobs: jobCount,
    jobSource: ctx.jobSource,
    ...fetched,
    purchases: fetched.Purchase ?? 0,
    bills: fetched.Bill ?? 0,
    timeActivities: fetched.TimeActivity ?? 0,
    invoices: fetched.Invoice ?? 0,
    estimates: fetched.Estimate ?? 0,
    costRowsWritten: writer.seenCost.size,
    costRowsUpdated: writer.costUpdates,
    costRowsRemoved: removedCosts,
    revenueRowsUpdated: writer.revenueUpdates,
    revenueRowsRemoved: removedRevenue,
    countersWindowDays: COUNTER_WINDOW_DAYS,
    ...roundTallies(tallies),
    ...(Object.keys(errors).length > 0 ? { partialErrors: errors } : {}),
  };
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

async function runIncrementalSync(ctx: SyncCtx, changedSince: Date): Promise<Record<string, any>> {
  const errors: Record<string, string> = {};
  const cdc = await qboCdc(ctx.realmId, ctx.accessToken, CDC_ENTITIES, changedSince);
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
  const cdcTotal = CDC_ENTITIES.reduce((sum, name) => sum + byEntity(name).length, 0);
  if (cdcTotal >= CDC_MAX_PER_ENTITY) throw new Error(`Change Data Capture returned ${cdcTotal} records, at or over its cap`);

  const lookups = await loadLookups(ctx);
  const customers = byEntity("Customer").filter((c) => c?.status !== "Deleted");
  const jobCount = await upsertJobs(ctx, customers, false);
  const index = await loadJobIndex(ctx.connectionId);

  // Only the stored rows of the transactions that changed are loaded:
  // everything else is left exactly as it is, and a nightly sync doesn't
  // read a company's whole history to update a handful of bills.
  const changedIds = new Map<string, string[]>();
  for (const type of [...EXPENSE_TYPES, "TimeActivity", ...REVENUE_TYPES]) {
    const ids = byEntity(type).filter((t) => t?.Id != null).map((t) => String(t.Id));
    if (ids.length) changedIds.set(type, ids);
  }
  const { existingCost, existingRevenue } = await loadExisting(ctx.connectionId, changedIds);
  const writer = new Writer(existingCost, existingRevenue);
  const tallies = newTallies();
  const p: Processor = { ctx, lookups, index, writer, tallies, windowStart: ctx.startedAt.getTime() - COUNTER_WINDOW_DAYS * 86_400_000 };

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
      if (txn.status !== "Deleted") await processExpenseTxn(p, txn, type);
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
  await writer.flush();

  const costTypes = new Set(touchedCost.keys());
  const removedCosts = await deleteCostRows(
    writer.unseenCost(costTypes, (r) => touchedCost.get(r.qboSourceType)?.has(r.qboSourceId) ?? false)
  );
  const revenueTypes = new Set(touchedRevenue.keys());
  const removedRevenue = await deleteRevenueRows(
    writer.unseenRevenue(revenueTypes, (r) => touchedRevenue.get(r.qboSourceType)?.has(r.qboInvoiceId) ?? false)
  );

  const estimates = byEntity("Estimate");
  counts.Estimate = estimates.length;
  if (estimates.length) await applyEstimates(ctx, estimates, false, lookups);

  return {
    jobs: jobCount,
    jobSource: ctx.jobSource,
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
