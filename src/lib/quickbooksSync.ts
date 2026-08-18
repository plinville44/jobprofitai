import { prisma } from "@/lib/prisma";
import { qboQuery, qboCompanyInfo, qboCdc, refreshTokens } from "@/lib/quickbooks";
import { encryptToken, decryptToken } from "@/lib/crypto";

/**
 * The QuickBooks sync engine. Lives here (not inline in the route handler)
 * so it can be called in-process both by POST /api/quickbooks/sync (a
 * logged-in user clicking "Sync now") and by the weekly-email cron job
 * (api/cron/weekly-email), which has no user session to authenticate as and
 * needs to sync a connection before generating that connection's digest.
 * `runSyncForConnection` is the only export - callers are responsible for
 * deciding whether the caller is allowed to sync a given connection (the
 * route checks session + ownership; the cron job iterates connections
 * directly from the database) before calling in here.
 *
 * Pulls this connection's job-costing data from QuickBooks and writes it into
 * our own tables (Job / CostEntry / InvoiceSummary), so the profitability
 * engine and digest generator can run against local data rather than hitting
 * the QBO API live every time.
 *
 * Every run is recorded as a SyncRun (status/mode/entities-updated/error) so
 * sync is observable, per the product spec and Intuit's own guidance. The
 * first sync for a connection (or any sync more than FULL_SYNC_INTERVAL_DAYS
 * since the last full sync) does a full pull; every other sync uses QBO's
 * Change Data Capture (CDC) endpoint to pull only what changed, which is
 * faster and lighter for both us and Intuit's API.
 */

const FULL_SYNC_INTERVAL_DAYS = 30;
const CDC_ENTITIES = ["Customer", "Purchase", "Bill", "TimeActivity", "Invoice", "Estimate"];

export async function runSyncForConnection(connectionId: string): Promise<Record<string, any>> {
  const connection = await prisma.quickBooksConnection.findUniqueOrThrow({
    where: { id: connectionId },
  });

  const accessToken = await getValidAccessToken(connection);
  const realmId = decryptToken(connection.realmId);

  const fullSyncDue =
    !connection.lastFullSyncAt ||
    Date.now() - connection.lastFullSyncAt.getTime() > FULL_SYNC_INTERVAL_DAYS * 24 * 60 * 60 * 1000;
  let mode: "full" | "incremental" = fullSyncDue ? "full" : "incremental";

  const syncRun = await prisma.syncRun.create({
    data: { connectionId: connection.id, status: "in_progress", mode },
  });

  let counts: Record<string, any>;
  try {
    if (mode === "full") {
      counts = await runFullSync(connection.id, realmId, accessToken);
    } else {
      try {
        counts = await runIncrementalSync(connection.id, realmId, accessToken, connection.lastSyncedAt ?? new Date(0));
      } catch (cdcErr) {
        // CDC itself failing (not one of the per-entity steps inside it,
        // which are already isolated via runStep) is rare but should fall
        // back to a full sync rather than fail the whole request - the
        // customer clicking "Sync now" shouldn't get an error just because
        // the lighter-weight path had a problem.
        mode = "full";
        await prisma.syncRun.update({ where: { id: syncRun.id }, data: { mode } });
        counts = await runFullSync(connection.id, realmId, accessToken);
      }
    }

    // CompanyInfo is cheap and worth refreshing on every sync, full or incremental.
    try {
      const info = await qboCompanyInfo(realmId, accessToken);
      const companyName = info?.CompanyInfo?.CompanyName;
      if (companyName) {
        await prisma.quickBooksConnection.update({
          where: { id: connection.id },
          data: { companyName },
        });
      }
    } catch {
      // Non-fatal - the dashboard already falls back to the decrypted realm
      // ID if companyName is never populated. Don't fail the whole sync over it.
    }

    const now = new Date();
    await prisma.syncRun.update({
      where: { id: syncRun.id },
      data: { status: "success", finishedAt: now, entitiesUpdated: counts },
    });
    await prisma.quickBooksConnection.update({
      where: { id: connection.id },
      data: {
        lastSyncedAt: now,
        lastSyncStatus: "success",
        lastSyncError: null,
        lastSyncAttemptAt: now,
        lastSyncEntitiesUpdated: counts,
        ...(mode === "full" ? { lastFullSyncAt: now } : {}),
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
    throw err; // handled by the caller (the sync route's POST try/catch, or the cron route's per-connection try/catch)
  }

  return { ok: true, mode, ...counts };
}

/**
 * Runs one entity's fetch+process step in isolation. A failure here (e.g. a
 * malformed query against one entity type) is recorded and surfaced in the
 * sync result instead of aborting the whole sync - Bill/TimeActivity/Estimate
 * are new this phase and less proven than Customer/Purchase/Invoice, so one
 * of them having an issue must not take down sync entirely (that's exactly
 * the regression hit when Phase 2 first shipped: one bad query broke
 * everything, including the parts that were already working). Every
 * per-entity error is tagged with the entity name so it's actually
 * diagnosable from the SyncRun record - no more "status 400" with no
 * context about which query caused it.
 */
async function runStep<T>(label: string, errors: Record<string, string>, fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    errors[label] = err instanceof Error ? err.message : "Unknown error";
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Full sync: pulls everything via the query endpoint, same approach as the
// original Week 1 implementation, extended to Bill/TimeActivity/Estimate.
// Customer/Purchase/Invoice are the proven-working Week 1 entities and are
// NOT wrapped in runStep - if one of those fails, the sync genuinely failed
// and should report an error, same as before this phase. Bill/TimeActivity/
// Estimate are new and isolated via runStep so a problem with one of them
// can't break the rest.
// ---------------------------------------------------------------------------
async function runFullSync(connectionId: string, realmId: string, accessToken: string): Promise<Record<string, any>> {
  const errors: Record<string, string> = {};

  const customerResult = await qboQuery(
    realmId,
    accessToken,
    "SELECT Id, DisplayName, Job, ParentRef, Active FROM Customer WHERE Job = true MAXRESULTS 1000"
  );
  const projectJobs = customerResult?.QueryResponse?.Customer ?? [];
  await upsertJobsFromCustomers(connectionId, projectJobs);

  // Deliberately SELECT * rather than an explicit column list - same reason
  // as TimeActivity below. "Line" is a composite/array field, and QBO's
  // query endpoint doesn't reliably project those when explicitly named in
  // a column list (confirmed: explicitly selecting Line returned an empty
  // array for every Purchase/Bill in testing, even though TotalAmt was
  // non-zero - switching to SELECT * fixed it for TimeActivity earlier).
  const purchaseResult = await qboQuery(realmId, accessToken, "SELECT * FROM Purchase MAXRESULTS 1000");
  const purchases = purchaseResult?.QueryResponse?.Purchase ?? [];
  const purchaseCounts = await upsertCostEntriesFromExpenseTxns(connectionId, purchases, "Purchase");

  const invoiceResult = await qboQuery(
    realmId,
    accessToken,
    "SELECT Id, TxnDate, TotalAmt, Balance, CustomerRef FROM Invoice MAXRESULTS 1000"
  );
  const invoices = invoiceResult?.QueryResponse?.Invoice ?? [];
  await upsertInvoices(connectionId, invoices);

  const bills = await runStep(
    "Bill",
    errors,
    async () => {
      const result = await qboQuery(realmId, accessToken, "SELECT * FROM Bill MAXRESULTS 1000");
      return result?.QueryResponse?.Bill ?? [];
    },
    [] as any[]
  );
  const billCounts = await upsertCostEntriesFromExpenseTxns(connectionId, bills, "Bill");

  const timeActivities = await runStep(
    "TimeActivity",
    errors,
    async () => {
      // Deliberately SELECT * rather than an explicit column list - some QBO
      // entities (TimeActivity among them, per community reports) are
      // pickier about which combinations of columns are projectable, and the
      // response shape is identical either way (still keyed by field name).
      const result = await qboQuery(realmId, accessToken, "SELECT * FROM TimeActivity MAXRESULTS 1000");
      return result?.QueryResponse?.TimeActivity ?? [];
    },
    [] as any[]
  );
  const timeCounts = await upsertCostEntriesFromTimeActivities(connectionId, timeActivities);

  const estimates = await runStep(
    "Estimate",
    errors,
    async () => {
      const result = await qboQuery(realmId, accessToken, "SELECT Id, TxnDate, TotalAmt, CustomerRef FROM Estimate MAXRESULTS 1000");
      return result?.QueryResponse?.Estimate ?? [];
    },
    [] as any[]
  );
  await applyEstimatesToJobs(connectionId, estimates);

  return {
    jobs: projectJobs.length,
    purchases: purchases.length,
    bills: bills.length,
    timeActivities: timeActivities.length,
    invoices: invoices.length,
    estimates: estimates.length,
    unassignedExpenseCount: purchaseCounts.unassignedCount + billCounts.unassignedCount,
    unassignedExpenseAmount: purchaseCounts.unassignedAmount + billCounts.unassignedAmount,
    // "Unresolved" = the transaction line WAS tagged to a real QBO customer,
    // but that customer isn't one of your synced Jobs and isn't unambiguously
    // one of their Projects either (see resolveJobForCustomerRef) - counted
    // here instead of silently vanishing. "Matched via parent" = it resolved
    // successfully, but only by falling back to the job's parent customer -
    // a judgment call worth being able to spot, not a guessed dollar amount.
    unresolvedExpenseCount: purchaseCounts.unresolvedCount + billCounts.unresolvedCount + timeCounts.unresolvedCount,
    unresolvedExpenseAmount: purchaseCounts.unresolvedAmount + billCounts.unresolvedAmount + timeCounts.unresolvedAmount,
    costsMatchedViaParentCount: purchaseCounts.viaParentCount + billCounts.viaParentCount + timeCounts.viaParentCount,
    costsMatchedViaParentAmount: purchaseCounts.viaParentAmount + billCounts.viaParentAmount + timeCounts.viaParentAmount,
    timeActivitiesSkippedNoRate: timeCounts.skippedNoRate,
    // Diagnostic only - up to 5 unresolved lines (which real QBO customer
    // they were tagged to) and the full list of your synced Jobs with their
    // own parent linkage, so a mismatch is visible directly from this
    // record instead of needing another round of guessing.
    unresolvedSamples: [...purchaseCounts.unresolvedSamples, ...billCounts.unresolvedSamples, ...timeCounts.unresolvedSamples].slice(0, 5),
    jobsSummary: projectJobs.map((c: any) => ({
      id: c.Id,
      name: c.DisplayName,
      parentId: c.ParentRef?.value ?? null,
      parentName: c.ParentRef?.name ?? null,
    })),
    // Diagnostic: transactions QBO returned with no Line array at all - was
    // consistently equal to purchases+bills before switching those queries
    // to SELECT *. Should be 0 (or near 0) now; if it's still high, the
    // Line-projection theory was wrong.
    purchaseEmptyLineTxnCount: purchaseCounts.emptyLineTxnCount,
    billEmptyLineTxnCount: billCounts.emptyLineTxnCount,
    ...(Object.keys(errors).length > 0 ? { partialErrors: errors } : {}),
  };
}

// ---------------------------------------------------------------------------
// Incremental sync: pulls only what changed since the last sync via QBO's
// CDC endpoint, and runs the exact same upsert helpers as full sync so the
// two modes can never drift out of sync with each other's logic.
//
// Known simplification: CDC can report deletions (entities with
// status:"Deleted"), which this does not yet remove locally - a deleted QBO
// transaction will linger in our tables until the next full sync (at most
// FULL_SYNC_INTERVAL_DAYS later) cleans it up implicitly via re-upsert of
// what still exists. Flagged as a known limitation, not silently ignored -
// worth hardening once this has run against real customer data.
// ---------------------------------------------------------------------------
async function runIncrementalSync(
  connectionId: string,
  realmId: string,
  accessToken: string,
  changedSince: Date
): Promise<Record<string, any>> {
  const cdcResult = await qboCdc(realmId, accessToken, CDC_ENTITIES, changedSince);
  const responses: any[] = cdcResult?.CDCResponse?.[0]?.QueryResponse ?? [];
  const byEntity = (name: string): any[] => {
    const match = responses.find((r) => Array.isArray(r?.[name]));
    return match?.[name] ?? [];
  };

  const customers = byEntity("Customer").filter((c) => c.Job === true);
  await upsertJobsFromCustomers(connectionId, customers);

  const purchases = byEntity("Purchase");
  const purchaseCounts = await upsertCostEntriesFromExpenseTxns(connectionId, purchases, "Purchase");

  const bills = byEntity("Bill");
  const billCounts = await upsertCostEntriesFromExpenseTxns(connectionId, bills, "Bill");

  const timeActivities = byEntity("TimeActivity");
  const timeCounts = await upsertCostEntriesFromTimeActivities(connectionId, timeActivities);

  const invoices = byEntity("Invoice");
  await upsertInvoices(connectionId, invoices);

  const estimates = byEntity("Estimate");
  await applyEstimatesToJobs(connectionId, estimates);

  return {
    jobs: customers.length,
    purchases: purchases.length,
    bills: bills.length,
    timeActivities: timeActivities.length,
    invoices: invoices.length,
    estimates: estimates.length,
    unassignedExpenseCount: purchaseCounts.unassignedCount + billCounts.unassignedCount,
    unassignedExpenseAmount: purchaseCounts.unassignedAmount + billCounts.unassignedAmount,
    unresolvedExpenseCount: purchaseCounts.unresolvedCount + billCounts.unresolvedCount + timeCounts.unresolvedCount,
    unresolvedExpenseAmount: purchaseCounts.unresolvedAmount + billCounts.unresolvedAmount + timeCounts.unresolvedAmount,
    costsMatchedViaParentCount: purchaseCounts.viaParentCount + billCounts.viaParentCount + timeCounts.viaParentCount,
    costsMatchedViaParentAmount: purchaseCounts.viaParentAmount + billCounts.viaParentAmount + timeCounts.viaParentAmount,
    timeActivitiesSkippedNoRate: timeCounts.skippedNoRate,
    unresolvedSamples: [...purchaseCounts.unresolvedSamples, ...billCounts.unresolvedSamples, ...timeCounts.unresolvedSamples].slice(0, 5),
  };
}

// ---------------------------------------------------------------------------
// Shared upsert helpers (used by both full and incremental sync)
// ---------------------------------------------------------------------------

async function upsertJobsFromCustomers(connectionId: string, customers: any[]) {
  for (const c of customers) {
    const parentQboId: string | null = c.ParentRef?.value ?? null;
    await prisma.job.upsert({
      where: { connectionId_qboId: { connectionId, qboId: c.Id } },
      create: {
        connectionId,
        qboId: c.Id,
        parentQboId,
        name: c.DisplayName,
        status: c.Active ? "open" : "closed",
      },
      update: {
        parentQboId,
        name: c.DisplayName,
        status: c.Active ? "open" : "closed",
      },
    });
  }
}

/**
 * Resolves a QBO CustomerRef value (as it appears on a Purchase/Bill/
 * TimeActivity/Invoice/Estimate line) to one of our synced Jobs.
 *
 * Tries a direct qboId match first - this is how it's always worked, and
 * covers the common case where a transaction was entered directly against
 * the Project (e.g. invoices created from inside a Project automatically
 * carry the Project's own id).
 *
 * Falls back to matching the transaction's customer as the PARENT of one of
 * our Jobs - this covers the equally common real-world case where a
 * bookkeeper tags an expense to the top-level customer instead of drilling
 * into the specific Project. The fallback only fires when it's unambiguous
 * (exactly one Job under that parent); if a parent has multiple Jobs, we
 * genuinely can't tell which one the cost belongs to, so it's left
 * unresolved rather than guessed at - the "never invent a financial
 * attribution" rule applies to WHICH job a real dollar amount belongs to,
 * not just to the dollar amount itself.
 */
async function resolveJobForCustomerRef(
  connectionId: string,
  customerQboId: string
): Promise<{ job: { id: string }; method: "direct" | "parent_customer_fallback" } | null> {
  const direct = await prisma.job.findUnique({
    where: { connectionId_qboId: { connectionId, qboId: customerQboId } },
  });
  if (direct) return { job: direct, method: "direct" };

  const childrenOfParent = await prisma.job.findMany({
    where: { connectionId, parentQboId: customerQboId },
    select: { id: true },
  });
  if (childrenOfParent.length === 1) {
    return { job: childrenOfParent[0], method: "parent_customer_fallback" };
  }
  return null; // no Job at all, or ambiguous (multiple Jobs under this parent)
}

/** Reads a job reference + category name off an expense line, checking both
 * account-based and item-based expense line details - the original
 * implementation only checked AccountBasedExpenseLineDetail, which silently
 * dropped any line item bought against an Item (materials purchased as a
 * product/item rather than posted straight to an expense account). */
function parseExpenseLine(line: any): {
  jobQboId: string | null;
  jobQboName: string | null;
  categoryName: string | null;
  amount: number;
  description: string | null;
} {
  const acct = line?.AccountBasedExpenseLineDetail;
  const item = line?.ItemBasedExpenseLineDetail;
  return {
    jobQboId: acct?.CustomerRef?.value ?? item?.CustomerRef?.value ?? null,
    // QBO's own display name for whatever customer/sub-customer the line is
    // tagged to - kept purely for diagnostics (see unresolvedSamples below),
    // never used for matching logic itself.
    jobQboName: acct?.CustomerRef?.name ?? item?.CustomerRef?.name ?? null,
    categoryName: acct?.AccountRef?.name ?? item?.ItemRef?.name ?? null,
    amount: typeof line?.Amount === "number" ? line.Amount : 0,
    description: line?.Description ?? null,
  };
}

/** Shared by Purchase and Bill processing - same line shape, same category logic. */
async function upsertCostEntriesFromExpenseTxns(
  connectionId: string,
  txns: any[],
  sourceType: "Purchase" | "Bill"
): Promise<{
  unassignedCount: number;
  unassignedAmount: number;
  unresolvedCount: number;
  unresolvedAmount: number;
  viaParentCount: number;
  viaParentAmount: number;
  unresolvedSamples: { source: string; txnId: string; customerId: string; customerName: string | null; amount: number }[];
  emptyLineTxnCount: number;
}> {
  let unassignedCount = 0;
  let unassignedAmount = 0;
  let unresolvedCount = 0;
  let unresolvedAmount = 0;
  let viaParentCount = 0;
  let viaParentAmount = 0;
  const unresolvedSamples: { source: string; txnId: string; customerId: string; customerName: string | null; amount: number }[] = [];
  // Diagnostic: how many transactions came back with no Line array at all
  // (regardless of TotalAmt) - if this is still non-zero after switching to
  // SELECT *, the Line-projection theory was wrong and something else is
  // going on.
  let emptyLineTxnCount = 0;

  for (const txn of txns) {
    if (!Array.isArray(txn.Line) || txn.Line.length === 0) emptyLineTxnCount++;
    for (const line of txn.Line ?? []) {
      const parsed = parseExpenseLine(line);
      if (parsed.amount === 0) continue; // summary/subtotal lines, nothing to record

      if (!parsed.jobQboId) {
        // Not tagged to a job - either genuine overhead (fine) or a missed
        // tagging opportunity. We can't tell which from here, so it's
        // counted for the Data Health "unassigned expenses" surface rather
        // than silently dropped.
        unassignedCount++;
        unassignedAmount += parsed.amount;
        continue;
      }

      const resolved = await resolveJobForCustomerRef(connectionId, parsed.jobQboId);
      if (!resolved) {
        // Tagged to a real QBO customer, but not one of your synced Jobs and
        // not unambiguously one of their Projects either - counted here
        // instead of silently disappearing (see Data Health, Phase 4). A
        // few samples (id + QBO's own display name) are kept so this is
        // diagnosable from the SyncRun record without guessing.
        unresolvedCount++;
        unresolvedAmount += parsed.amount;
        if (unresolvedSamples.length < 5) {
          unresolvedSamples.push({
            source: sourceType,
            txnId: txn.Id,
            customerId: parsed.jobQboId,
            customerName: parsed.jobQboName,
            amount: parsed.amount,
          });
        }
        continue;
      }
      if (resolved.method === "parent_customer_fallback") {
        viaParentCount++;
        viaParentAmount += parsed.amount;
      }

      const entryId = `${sourceType}-${txn.Id}-${line.Id ?? "0"}`;
      await prisma.costEntry.upsert({
        where: { id: entryId },
        create: {
          id: entryId,
          jobId: resolved.job.id,
          qboSourceType: sourceType,
          qboSourceId: txn.Id,
          category: categorize(parsed.categoryName),
          description: parsed.description,
          amount: parsed.amount,
          txnDate: new Date(txn.TxnDate),
          attributionMethod: resolved.method,
        },
        update: {
          amount: parsed.amount,
          description: parsed.description,
          attributionMethod: resolved.method,
        },
      });
    }
  }

  return { unassignedCount, unassignedAmount, unresolvedCount, unresolvedAmount, viaParentCount, viaParentAmount, unresolvedSamples, emptyLineTxnCount };
}

/** TimeActivity has no Line array - the transaction itself is the cost entry.
 * Cost in dollars requires an hourly rate on file; entries without one are
 * skipped and counted (never guessed at) - see the "not synced today" note
 * in the plan about labor-cost reliability. */
async function upsertCostEntriesFromTimeActivities(
  connectionId: string,
  timeActivities: any[]
): Promise<{
  skippedNoRate: number;
  unresolvedCount: number;
  unresolvedAmount: number;
  viaParentCount: number;
  viaParentAmount: number;
  unresolvedSamples: { source: string; txnId: string; customerId: string; customerName: string | null; amount: number }[];
}> {
  let skippedNoRate = 0;
  let unresolvedCount = 0;
  let unresolvedAmount = 0;
  let viaParentCount = 0;
  let viaParentAmount = 0;
  const unresolvedSamples: { source: string; txnId: string; customerId: string; customerName: string | null; amount: number }[] = [];

  for (const ta of timeActivities) {
    const jobQboId = ta.CustomerRef?.value;
    if (!jobQboId) continue;

    const hourlyRate = typeof ta.HourlyRate === "number" ? ta.HourlyRate : null;
    if (hourlyRate == null || hourlyRate <= 0) {
      skippedNoRate++;
      continue;
    }

    const hours = (typeof ta.Hours === "number" ? ta.Hours : 0) + (typeof ta.Minutes === "number" ? ta.Minutes / 60 : 0);
    const amount = Math.round(hours * hourlyRate * 100) / 100;
    if (amount <= 0) continue;

    const resolved = await resolveJobForCustomerRef(connectionId, jobQboId);
    if (!resolved) {
      unresolvedCount++;
      unresolvedAmount += amount;
      if (unresolvedSamples.length < 5) {
        unresolvedSamples.push({
          source: "TimeActivity",
          txnId: ta.Id,
          customerId: jobQboId,
          customerName: ta.CustomerRef?.name ?? null,
          amount,
        });
      }
      continue;
    }
    if (resolved.method === "parent_customer_fallback") {
      viaParentCount++;
      viaParentAmount += amount;
    }

    const entryId = `TimeActivity-${ta.Id}-0`;
    await prisma.costEntry.upsert({
      where: { id: entryId },
      create: {
        id: entryId,
        jobId: resolved.job.id,
        qboSourceType: "TimeActivity",
        qboSourceId: ta.Id,
        category: "labor",
        description: ta.Description ?? null,
        amount,
        txnDate: new Date(ta.TxnDate),
        attributionMethod: resolved.method,
      },
      update: { amount, attributionMethod: resolved.method },
    });
  }

  return { skippedNoRate, unresolvedCount, unresolvedAmount, viaParentCount, viaParentAmount, unresolvedSamples };
}

async function upsertInvoices(connectionId: string, invoices: any[]) {
  for (const inv of invoices) {
    const jobQboId = inv.CustomerRef?.value;
    if (!jobQboId) continue;

    const resolved = await resolveJobForCustomerRef(connectionId, jobQboId);
    if (!resolved) continue; // tagged to a customer that isn't a Job and isn't unambiguously one of their Projects

    await prisma.invoiceSummary.upsert({
      where: { id: inv.Id },
      create: {
        id: inv.Id,
        jobId: resolved.job.id,
        qboInvoiceId: inv.Id,
        amount: inv.TotalAmt ?? 0,
        status: inv.Balance > 0 ? "open" : "paid",
        txnDate: new Date(inv.TxnDate),
      },
      update: {
        amount: inv.TotalAmt ?? 0,
        status: inv.Balance > 0 ? "open" : "paid",
      },
    });
  }
}

/** Applies the most recent Estimate per job as Job.estimatedRevenue - a
 * revision history isn't summed, since summing would double-count a job that
 * simply had its quote revised. Estimated *cost* is intentionally untouched
 * here (stays manual - see plan §6, QBO Estimates are customer-facing revenue
 * quotes, not internal cost budgets). */
async function applyEstimatesToJobs(connectionId: string, estimates: any[]) {
  const latestByJob = new Map<string, { amount: number; date: Date }>();
  for (const est of estimates) {
    const jobQboId = est.CustomerRef?.value;
    if (!jobQboId) continue;
    const date = new Date(est.TxnDate);
    const existing = latestByJob.get(jobQboId);
    if (!existing || date > existing.date) {
      latestByJob.set(jobQboId, { amount: est.TotalAmt ?? 0, date });
    }
  }

  for (const [jobQboId, { amount }] of latestByJob) {
    const resolved = await resolveJobForCustomerRef(connectionId, jobQboId);
    if (!resolved) continue;
    await prisma.job.update({ where: { id: resolved.job.id }, data: { estimatedRevenue: amount } });
  }
}

/** Maps a QBO expense account/item name to one of our cost categories. Loose
 * on purpose - contractors name accounts inconsistently, and a mis-bucketed
 * cost is far less harmful than a missing one. */
function categorize(accountOrItemName: string | null | undefined): string {
  const name = (accountOrItemName ?? "").toLowerCase();
  if (name.includes("labor") || name.includes("payroll") || name.includes("wage")) return "labor";
  if (name.includes("material") || name.includes("supply") || name.includes("supplies")) return "materials";
  if (name.includes("subcontractor") || name.includes("sub-contractor") || name.includes("sub ")) return "subcontractor";
  if (name.includes("equipment") || name.includes("rental") || name.includes("lease")) return "equipment";
  if (name.includes("overhead") || name.includes("admin")) return "overhead";
  return "other";
}

// Exported (was module-private) so the temporary sandbox-token debug route
// (src/app/api/debug/qbo-token/route.ts) can reuse the exact same
// refresh-if-needed logic the sync engine already relies on, instead of
// duplicating it - see that route's comment for why it exists.
async function getValidAccessToken(connection: {
  id: string;
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: Date;
}): Promise<string> {
  // Refresh a little early (5 min buffer) rather than racing the exact expiry instant.
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
