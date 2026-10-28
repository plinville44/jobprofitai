import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { createFakePrisma, FakeModel } from "./support/fakePrisma";
import { buildJobIndex, contractValueFromEstimates, estimatesByJob } from "../qboNormalize";

// Fixes from the Oct 27, 2026 audit to how figures are worked out. One block
// per audit item, numbered as in the audit doc.

// --- Stand-ins (F2's sync, and the pages' loaders in F6 to F8) ----------------

// vi.mock factories run before the rest of this file, so everything they
// use is made in vi.hoisted. Each block puts its own client in db.client.
const db = vi.hoisted(() => ({ client: {} as Record<string, any> }));
vi.mock("@/lib/prisma", () => ({
  get prisma() {
    return db.client;
  },
}));
vi.mock("@/lib/crypto", () => ({
  encryptToken: (s: string) => s,
  decryptToken: (s: string) => s,
}));
// Every plan feature on, so forecasts are made.
vi.mock("@/lib/entitlements", () => ({ requireFeature: async () => ({}) }));
// A pretend QuickBooks: what each query returns, which types fail, and the
// point each change feed request asks from.
const qbo = vi.hoisted(() => ({
  data: {} as Record<string, any[]>,
  cdc: {} as Record<string, any[]>,
  fail: new Set<string>(),
  cdcSince: [] as Date[],
  // Like QuickBooks, the change feed refuses a start further back than this, when set.
  cdcReachDays: null as number | null,
}));
vi.mock("@/lib/quickbooks", () => ({
  qboQueryAll: async (_realm: string, _token: string, _query: string, entity: string) => {
    if (qbo.fail.has(entity)) throw new Error("QuickBooks API query failed with status 500");
    return qbo.data[entity] ?? [];
  },
  qboQuery: async (_realm: string, _token: string, query: string) => {
    const entity = /FROM\s+(\w+)/i.exec(query)?.[1] ?? "";
    return { QueryResponse: { totalCount: (qbo.data[entity] ?? []).length } };
  },
  qboCompanyInfo: async () => ({}),
  qboCdc: async (_realm: string, _token: string, entities: string[], changedSince: Date) => {
    qbo.cdcSince.push(changedSince);
    if (qbo.cdcReachDays != null && Date.now() - changedSince.getTime() > qbo.cdcReachDays * 86_400_000) {
      throw new Error("QuickBooks API request failed with status 400");
    }
    return { CDCResponse: [{ QueryResponse: entities.filter((e) => qbo.cdc[e]).map((e) => ({ [e]: qbo.cdc[e] })) }] };
  },
  refreshTokens: async () => {
    throw new Error("not expected");
  },
  needsReconnect: (message: string | null | undefined) => (message ?? "").startsWith("Your QuickBooks connection has expired"),
}));

const day = (iso: string) => new Date(`${iso}T00:00:00Z`);

describe("F1: estimates on the parent customer don't change a project's own contract", () => {
  // Jones has one project, created Sep 1, 2026. Earlier work for Jones was
  // done on the customer record itself.
  const index = buildJobIndex([{ id: "basement", qboId: "11", parentQboId: "10", qboCreatedAt: day("2026-09-01") }]);
  const est = (customerQboId: string, status: string, amount: number, date: string) => ({ customerQboId, status, amount, txnDate: day(date) });
  const contract = (list: ReturnType<typeof est>[]) => contractValueFromEstimates(estimatesByJob(index, list).get("basement") ?? []);

  it("keeps the project's accepted $60,000 when an earlier deck estimate on the customer is closed", () => {
    expect(contract([est("11", "Accepted", 60_000, "2026-08-20"), est("10", "Closed", 25_000, "2026-02-10")])).toBe(60_000);
  });

  it("keeps the project's own pending estimate when a newer bid for other work is made on the customer", () => {
    expect(contract([est("11", "Pending", 60_000, "2026-08-20"), est("10", "Pending", 15_000, "2026-10-15")])).toBe(60_000);
  });

  it("still uses the customer's estimate when the project has none of its own", () => {
    // A bid made on the customer in spring for the job set up in autumn.
    expect(contract([est("10", "Accepted", 48_000, "2026-04-02")])).toBe(48_000);
    expect(contract([est("10", "Pending", 48_000, "2026-04-02")])).toBe(48_000);
    // The project's only estimate was rejected: the customer's counts.
    expect(contract([est("11", "Rejected", 50_000, "2026-08-20"), est("10", "Accepted", 48_000, "2026-08-01")])).toBe(48_000);
  });

  it("leaves out an invoiced estimate on the customer from well before the project (its invoices are an earlier job's)", () => {
    expect(contract([est("10", "Closed", 25_000, "2026-02-10")])).toBeNull();
    // Inside the 60 days that deposits and early bills get, it still counts.
    expect(contract([est("10", "Closed", 25_000, "2026-08-01")])).toBe(25_000);
  });

  it("adds the project's own change order to the bid signed on the customer just before the project was set up", () => {
    // The $60,000 bid was written on Jones in August; the project got a $5,000 change order of its own.
    expect(contract([est("10", "Accepted", 60_000, "2026-08-15"), est("11", "Accepted", 5_000, "2026-10-01")])).toBe(65_000);
    // A change order still pending: the signed bid is the contract.
    expect(contract([est("10", "Accepted", 60_000, "2026-08-15"), est("11", "Pending", 5_000, "2026-10-01")])).toBe(60_000);
    // Converted to an invoice in QuickBooks (Closed) counts the same.
    expect(contract([est("10", "Closed", 60_000, "2026-08-15"), est("11", "Accepted", 5_000, "2026-10-01")])).toBe(65_000);
  });

  it("leaves out an earlier job's signed estimate on the customer when the project has its own", () => {
    // Jones's February deck was accepted and never marked closed.
    expect(contract([est("11", "Accepted", 60_000, "2026-08-20"), est("10", "Accepted", 25_000, "2026-02-10")])).toBe(60_000);
    // A pending bid on the customer is other work, whatever its date.
    expect(contract([est("11", "Accepted", 60_000, "2026-08-20"), est("10", "Pending", 15_000, "2026-08-25")])).toBe(60_000);
  });

  it("matches nothing from the parent when it has two or more jobs, as before", () => {
    const two = buildJobIndex([
      { id: "a", qboId: "11", parentQboId: "10", qboCreatedAt: day("2026-09-01") },
      { id: "b", qboId: "12", parentQboId: "10", qboCreatedAt: day("2026-09-05") },
    ]);
    expect([...estimatesByJob(two, [est("10", "Accepted", 1_000, "2026-09-02")]).keys()]).toEqual([]);
  });
});

import { changeFeedStart, fullSyncDue, runSyncForConnection, SYNC_VERSION } from "../quickbooksSync";
import { emptyLookups, expenseLines, isWipAdjustmentAccount, journalRevenueLines } from "../qboNormalize";
import {
  computeDashboardTotals,
  computeDataHealth,
  computeJobFinancials,
  findPossibleDuplicateCostEntries,
  getConnectionProfitData,
  getJobProfitData,
  type FinancialContext,
  type JobFinancials,
} from "../profitability";
import { buildWipSchedule, NOT_SCHEDULED_NEED_TEXT, wipCountsInTotals, wipReportDay } from "../wipSchedule";
import { snapshotFigures } from "../wipSnapshots";
import { computeMoneyOwed } from "../moneyOwed";
import { computeOpportunityFeed, estimatesDetail, type EstimateFeedEntry } from "../opportunities";
import { getOpportunityData } from "../opportunityData";

const DAY = 86_400_000;
const read = (rel: string) => readFileSync(join(__dirname, "..", "..", rel), "utf8");

// ---------------------------------------------------------------------------
// F2. A read that failed during a sync, and the change feed
// ---------------------------------------------------------------------------

describe("F2: a sync that couldn't read a type doesn't move the change feed past it", () => {
  const accounts = [{ Id: "80", Name: "Job Materials", AccountType: "Cost of Goods Sold", AccountSubType: "SuppliesMaterialsCogs" }];
  const costLine = (id: string, amount: number, customer: string) => ({
    Id: id,
    Amount: amount,
    DetailType: "AccountBasedExpenseLineDetail",
    AccountBasedExpenseLineDetail: { AccountRef: { value: "80", name: "Job Materials" }, CustomerRef: { value: customer } },
  });
  const dayStr = (n: number) => new Date(Date.now() - n * DAY).toISOString().slice(0, 10);
  const connection = () => db.client.quickBooksConnection.findUnique({ where: { id: "c1" } }) as Promise<any>;
  const costsOnSmith = () => {
    const job = (db.client.job.rows as any[]).find((j) => j.qboId === "21");
    return (db.client.costEntry.rows as any[]).filter((r) => r.jobId === job.id).map((r) => [r.qboSourceType, r.qboSourceId, Number(r.amount)]);
  };

  beforeEach(() => {
    qbo.data = {
      Account: accounts,
      Customer: [{ Id: "21", DisplayName: "Smith House", Active: true }],
      Purchase: [{ Id: "p1", TxnDate: dayStr(20), Line: [costLine("1", 1_500, "21")] }],
      Bill: [{ Id: "b1", TxnDate: dayStr(20), Line: [costLine("1", 6_000, "21")] }],
    };
    qbo.cdc = {};
    qbo.fail = new Set();
    qbo.cdcSince = [];
    qbo.cdcReachDays = null;
    const c = createFakePrisma() as any;
    c.syncRun = new FakeModel("syncRun", [], () => ({ startedAt: new Date() }));
    c.costEntry = new FakeModel("costEntry");
    c.invoiceSummary = new FakeModel("invoiceSummary");
    c.categoryMapping = new FakeModel("categoryMapping");
    c.jobEstimate = new FakeModel("jobEstimate");
    c.untaggedCost = new FakeModel("untaggedCost");
    db.client = c;
  });

  async function addConnection(extra: Record<string, unknown> = {}) {
    const earlier = new Date(Date.now() - 2 * DAY);
    await db.client.quickBooksConnection.create({
      data: {
        id: "c1", userId: "u1", realmId: "realm", realmIdHash: "h1", accessToken: "token", refreshToken: "refresh",
        accessTokenExpiresAt: new Date(Date.now() + 3_600_000), companyName: "Acme Builders", jobSource: "customers",
        laborFromTimeEntries: true, syncVersion: SYNC_VERSION, lastFullSyncAt: earlier, lastSyncedAt: earlier,
        lastSyncAttemptAt: earlier, lastSyncStatus: "success", lastSyncError: null, jobSourceConfirmedAt: new Date(Date.now() - 30 * DAY),
        rebuildRequestedAt: null, basisChangedAt: null, fullSyncContinueAt: null, fullSyncCutShortAt: null,
        ...extra,
      },
    });
    return earlier;
  }

  it("reads changes again from before the sync that missed bills, and from the last start once a sync reads everything", async () => {
    const before = await addConnection();
    qbo.fail.add("Bill");
    const full = await runSyncForConnection("c1", { forceFull: true });
    expect(full.partialErrors).toEqual({ Bill: "QuickBooks API query failed with status 500" });
    const afterMiss = await connection();
    // lastSyncedAt still moves on: everything else reads it as the last sync that finished.
    expect(afterMiss.lastSyncedAt.getTime()).toBeGreaterThan(before.getTime());
    expect(changeFeedStart(afterMiss)).toEqual(before);

    // A bill entered while the read was failing comes through the change feed.
    qbo.fail = new Set();
    qbo.cdc = { Bill: [{ Id: "b9", TxnDate: dayStr(1), Line: [costLine("1", 4_000, "21")] }] };
    const next = await runSyncForConnection("c1");
    expect(next.mode).toBe("incremental");
    // From before the sync that missed bills, less the usual 5 minutes, not from that sync's start.
    expect(qbo.cdcSince.map((d) => d.getTime())).toEqual([before.getTime() - 5 * 60_000]);
    expect(costsOnSmith()).toContainEqual(["Bill", "b9", 4_000]);

    // That one read everything: the next starts from its start, as before.
    const settled = await connection();
    expect(changeFeedStart(settled)).toEqual(settled.lastSyncedAt);
    expect(settled.lastSyncEntitiesUpdated.changeFeedFrom).toBeUndefined();
    qbo.cdc = {};
    await runSyncForConnection("c1");
    expect(qbo.cdcSince[1].getTime()).toBe(settled.lastSyncedAt.getTime() - 5 * 60_000);
  });

  it("keeps the oldest start through more than one sync that misses a type", async () => {
    const before = await addConnection();
    qbo.fail.add("Bill");
    await runSyncForConnection("c1", { forceFull: true });
    await runSyncForConnection("c1", { forceFull: true });
    expect(changeFeedStart(await connection())).toEqual(before);
  });

  it("reads the change feed's start as the earlier of the two, and ignores anything else stored", () => {
    const last = new Date("2026-10-26T07:00:00Z");
    const at = (stored: unknown) => changeFeedStart({ lastSyncedAt: last, lastSyncEntitiesUpdated: stored as any });
    expect(at({ jobs: 4, changeFeedFrom: "2026-10-24T07:00:00.000Z" })).toEqual(new Date("2026-10-24T07:00:00Z"));
    expect(at({ jobs: 4 })).toEqual(last);
    expect(at({ changeFeedFrom: "not a date" })).toEqual(last);
    expect(at(null)).toEqual(last);
    expect(changeFeedStart({ lastSyncedAt: null, lastSyncEntitiesUpdated: null })).toBeNull();
  });

  it("doesn't take a company's first full read that missed a type as the full sync, and retries it for up to a day", async () => {
    await addConnection({ syncVersion: 1, lastFullSyncAt: null, lastSyncedAt: null, lastSyncAttemptAt: null, lastSyncStatus: null });
    qbo.fail.add("Bill");
    await runSyncForConnection("c1", { forceFull: true });
    let c = await connection();
    // Finished, and shown as synced, but not the full sync: no bill has ever been read.
    expect(c.lastSyncedAt).not.toBeNull();
    expect(c.lastFullSyncAt).toBeNull();
    expect(c.fullSyncCutShortAt).not.toBeNull();
    expect(fullSyncDue(c)).toBe(true);

    // The retry the same day misses bills again: still not the full sync.
    const retry = await runSyncForConnection("c1");
    expect(retry.mode).toBe("full");
    expect((await connection()).lastFullSyncAt).toBeNull();

    // Read in full: it is.
    qbo.fail = new Set();
    await runSyncForConnection("c1");
    c = await connection();
    expect(c.lastFullSyncAt).not.toBeNull();
    expect(c.fullSyncCutShortAt).toBeNull();
    expect(c.syncVersion).toBe(SYNC_VERSION);
  });

  it("accepts it after a day, so a type that keeps failing doesn't make every sync a full one", async () => {
    await addConnection({ syncVersion: 1, lastFullSyncAt: null, lastSyncedAt: null, lastSyncAttemptAt: null, lastSyncStatus: null });
    qbo.fail.add("Bill");
    await runSyncForConnection("c1", { forceFull: true });
    await db.client.quickBooksConnection.update({ where: { id: "c1" }, data: { fullSyncCutShortAt: new Date(Date.now() - 2 * DAY) } });
    await runSyncForConnection("c1");
    const c = await connection();
    expect(c.lastFullSyncAt).not.toBeNull();
    expect(c.fullSyncCutShortAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// F3 (put back) and F4. Journal entries: Construction in Progress, and WIP adjustments
// ---------------------------------------------------------------------------

const lookups = emptyLookups();
lookups.accounts.set("13", { name: "Construction in Progress", fullName: "Construction in Progress", type: "Other Current Asset", subType: "OtherCurrentAssets" });
lookups.accounts.set("19", { name: "Costs in excess of billings", fullName: "Costs in excess of billings", type: "Other Current Asset", subType: "OtherCurrentAssets" });
lookups.accounts.set("25", { name: "Billings in excess of costs", fullName: "Billings in excess of costs", type: "Other Current Liability", subType: "OtherCurrentLiabilities" });
lookups.accounts.set("11", { name: "Accounts Receivable", fullName: "Accounts Receivable (A/R)", type: "Accounts Receivable", subType: "AccountsReceivable" });
lookups.accounts.set("35", { name: "Checking", fullName: "Checking", type: "Bank", subType: "Checking" });
lookups.accounts.set("40", { name: "Construction Income", fullName: "Construction Income", type: "Income", subType: "SalesOfProductIncome" });
lookups.accounts.set("50", { name: "Job Materials", fullName: "Cost of Goods Sold:Job Materials", type: "Cost of Goods Sold", subType: "SuppliesMaterialsCogs" });

const jeLine = (id: string, amount: number, posting: "Debit" | "Credit", accountId: string, customer?: string) => ({
  Id: id,
  Amount: amount,
  JournalEntryLineDetail: {
    PostingType: posting,
    AccountRef: { value: accountId },
    ...(customer ? { Entity: { Type: "Customer", EntityRef: { value: customer } } } : {}),
  },
});
const je = (...Line: ReturnType<typeof jeLine>[]) => ({ Id: "9", TxnDate: "2026-09-30", Line });
const onJob = (lines: { customerQboId: string | null; amount: number }[], customer: string) =>
  lines.filter((l) => l.customerQboId === customer).reduce((s, l) => s + l.amount, 0);

describe("F3 (put back as before the audit): a closing entry's lines are read as they stand", () => {
  // F3 was reverted after review: the journal entry rules are as at d556fc5.
  // The sync-level cases are under "review 2: F3" below.
  it("counts the job-named cost line and leaves an unnamed Construction in Progress line out", () => {
    const lines = expenseLines(je(jeLine("0", 40_000, "Debit", "50", "201"), jeLine("1", 40_000, "Credit", "13")), "JournalEntry", lookups);
    expect(lines.map((l) => [l.customerQboId, l.amount])).toEqual([["201", 40_000]]);
  });

  it("counts both lines when both name the job, so they cancel", () => {
    const lines = expenseLines(je(jeLine("0", 40_000, "Debit", "50", "201"), jeLine("1", 40_000, "Credit", "13", "201")), "JournalEntry", lookups);
    expect(lines.map((l) => [l.customerQboId, l.amount])).toEqual([
      ["201", 40_000],
      ["201", -40_000],
    ]);
  });
});

describe("F4: the CPA's WIP adjusting entries aren't billing", () => {
  const NOW = new Date("2026-10-27T16:00:00Z");
  const ctx: FinancialContext = { now: NOW, targetMarginPct: 25, categoryTargetMarginPct: {}, overheadEnabled: false, overheadMethod: null, overheadValue: null, lastSyncedAt: NOW };

  it("leaves billed to date at what was invoiced, so the over billing the entry corrects still shows", () => {
    // Contract $100,000, $40,000 of an $80,000 estimate spent, $58,000 invoiced: $8,000 over billed.
    const adjustment = je(jeLine("0", 8_000, "Debit", "40", "201"), jeLine("1", 8_000, "Credit", "25", "201"));
    const revenue = journalRevenueLines(adjustment, lookups);
    expect(revenue).toEqual([]);
    expect(expenseLines(adjustment, "JournalEntry", lookups)).toEqual([]);
    const f = computeJobFinancials(
      {
        id: "j", name: "Smith House", customerName: null, status: "open", category: null, estimatedRevenue: 100_000, estimatedCost: 80_000,
        percentCompleteOverride: null, startDate: null, endDate: null, updatedAt: NOW,
        costEntries: [{ category: "materials", amount: 40_000, txnDate: new Date("2026-09-20") }],
        invoices: [{ amount: 58_000, status: "paid", txnDate: new Date("2026-09-25") }, ...revenue.map((l) => ({ amount: l.amount, status: "paid", txnDate: l.txnDate! }))],
      },
      ctx
    );
    expect(buildWipSchedule([f], NOW).inProgress[0]).toMatchObject({ billedToDate: 58_000, earnedRevenue: 50_000, overBilled: 8_000, underBilled: 0 });
  });

  it("skips the under billing adjustment too, by whichever name the account has", () => {
    expect(journalRevenueLines(je(jeLine("0", 5_000, "Debit", "19", "201"), jeLine("1", 5_000, "Credit", "40", "201")), lookups)).toEqual([]);
    const account = (name: string, type: string) => ({ name, fullName: name, type, subType: null });
    for (const name of ["Overbillings", "Underbillings", "Over/Under Billings", "Unbilled receivables", "Costs and estimated earnings in excess of billings"]) {
      expect({ name, wip: isWipAdjustmentAccount(account(name, name.startsWith("Under") || name.startsWith("Unbilled") || name.startsWith("Costs") ? "Other Current Asset" : "Other Current Liability")) }).toEqual({ name, wip: true });
    }
    // Not balance sheet holding accounts, or not about billing.
    expect(isWipAdjustmentAccount(account("Progress billings", "Income"))).toBe(false);
    expect(isWipAdjustmentAccount(account("Customer deposits", "Other Current Liability"))).toBe(false);
    expect(isWipAdjustmentAccount(account("Construction in Progress", "Other Current Asset"))).toBe(false);
  });

  it("still counts income recorded by journal entry against a receivable or the bank", () => {
    expect(journalRevenueLines(je(jeLine("0", 2_500, "Debit", "11", "201"), jeLine("1", 2_500, "Credit", "40", "201")), lookups).map((l) => l.amount)).toEqual([2_500]);
    expect(journalRevenueLines(je(jeLine("0", 900, "Debit", "35"), jeLine("1", 900, "Credit", "40", "201")), lookups).map((l) => l.amount)).toEqual([900]);
  });
});

// ---------------------------------------------------------------------------
// F5. An entered percent complete well ahead of the costs
// ---------------------------------------------------------------------------

describe("F5: an entered percent complete never gives a WIP row more profit to date than the job", () => {
  const NOW = new Date("2026-10-27T16:00:00Z");
  const ctx: FinancialContext = { now: NOW, targetMarginPct: 25, categoryTargetMarginPct: {}, overheadEnabled: false, overheadMethod: null, overheadValue: null, lastSyncedAt: NOW };
  // Contract $100,000, estimate $80,000, $60,000 billed.
  const elm = (percent: number | null, spent: number) =>
    computeJobFinancials(
      {
        id: "elm", name: "Elm St", customerName: null, status: "open", category: null, estimatedRevenue: 100_000, estimatedCost: 80_000,
        percentCompleteOverride: percent, startDate: null, endDate: null, updatedAt: NOW,
        costEntries: [{ category: "materials", amount: spent, txnDate: new Date("2026-10-10") }],
        invoices: [{ amount: 60_000, status: "paid", txnDate: new Date("2026-10-12") }],
      },
      ctx
    );

  it("lists a job entered as 100% or 90% complete with half its estimate spent, with what it needs, out of every total", () => {
    for (const percent of [100, 90]) {
      const f = elm(percent, 40_000);
      const s = buildWipSchedule([f], NOW);
      expect({ percent, rows: s.inProgress.length, notScheduled: s.notScheduled }).toEqual({ percent, rows: 0, notScheduled: [{ jobId: "elm", jobName: "Elm St", needs: "costs_behind" }] });
      expect(wipCountsInTotals(f, NOW)).toBe(false);
      // Money Owed and the month-end snapshot read the same schedule.
      expect(computeMoneyOwed({ now: NOW, openInvoices: [], jobs: [f] }).unbilled).toMatchObject({ total: 0, notChecked: { costs_behind: 1 } });
      expect(snapshotFigures(s).notScheduled).toEqual(s.notScheduled);
    }
    expect(NOT_SCHEDULED_NEED_TEXT.costs_behind).toBe("costs are well behind the percent complete entered: needs an updated percent complete or cost estimate");
  });

  it("keeps a job whose figures agree on the schedule as before", () => {
    // 60% entered: $20,000 gross profit to date, the whole $20,000 estimated.
    expect(buildWipSchedule([elm(60, 40_000)], NOW).inProgress[0]).toMatchObject({ estimatedGrossProfit: 20_000, grossProfitToDate: 20_000, costToComplete: 40_000 });
    // Past the estimate at 100%: nothing left to spend, profit to date is the job's.
    expect(buildWipSchedule([elm(100, 85_000)], NOW).inProgress[0]).toMatchObject({ estimatedGrossProfit: 15_000, grossProfitToDate: 15_000, costToComplete: 0 });
    // Cost to cost, no percent entered: unchanged.
    expect(buildWipSchedule([elm(null, 40_000)], NOW).inProgress[0]).toMatchObject({ percentComplete: 0.5, grossProfitToDate: 10_000 });
    // A finished job a little under its estimate, or a bill a few days late, isn't held off.
    expect(buildWipSchedule([elm(100, 79_000)], NOW).inProgress).toHaveLength(1);
    expect(buildWipSchedule([elm(95, 74_000)], NOW).inProgress).toHaveLength(1);
  });

  it("never shows gross profit to date more than $5,000 (5% of the contract) past the estimated gross profit", () => {
    for (const percent of [25, 40, 50, 60, 75, 90, 95, 100]) {
      for (const spent of [10_000, 20_000, 40_000, 60_000, 75_000, 79_000]) {
        const r = buildWipSchedule([elm(percent, spent)], NOW).inProgress[0];
        if (!r || r.estimatedGrossProfit == null || r.estimatedGrossProfit < 0) continue;
        expect({ percent, spent, over: r.grossProfitToDate - r.estimatedGrossProfit <= 5_000 }).toEqual({ percent, spent, over: true });
      }
    }
  });

  it("is listed on the WIP page, the bank-ready report and Money Owed in their own words", () => {
    expect(read("app/dashboard/wip/page.tsx")).toContain('j.needs === "costs_behind"');
    expect(read("app/reports/wip/page.tsx")).toContain("anyCostsBehind");
    expect(read("app/dashboard/money-owed/page.tsx")).toContain("n.costs_behind > 0");
    for (const f of ["lib/wipSchedule.ts", "app/dashboard/wip/page.tsx", "app/reports/wip/page.tsx", "app/dashboard/money-owed/page.tsx", "app/dashboard/jobs/[jobId]/page.tsx"]) {
      expect({ f, dashes: /[\u2013\u2014]/.test(read(f)) }).toEqual({ f, dashes: false });
    }
  });
});

// ---------------------------------------------------------------------------
// The tables the pages' loaders read, for F6 to F8 and F10
// ---------------------------------------------------------------------------

const PAGES_NOW = new Date("2026-10-27T16:00:00Z"); // 11 am in Chicago
const pages = { connection: {} as Record<string, any>, jobs: [] as Record<string, any>[], estimates: [] as Record<string, any>[] };

function usePagesDb() {
  pages.connection = {
    id: "c1", userId: "u1", companyName: "Acme Builders", targetMarginPct: 25, overheadEnabled: false, overheadMethod: null, overheadValue: null,
    lastSyncedAt: PAGES_NOW, laborBurdenPct: 0, laborBurdenSetAt: null, basisChangedAt: null, emailTimezone: "America/Chicago",
    jobSource: "projects", laborFromTimeEntries: true,
  };
  pages.jobs = [];
  pages.estimates = [];
  const withRows = (j: Record<string, any>) => ({ ...j, costEntries: [...j.costEntries], invoices: [...j.invoices] });
  db.client = {
    quickBooksConnection: {
      findUniqueOrThrow: async () => ({ ...pages.connection, marginTargets: [] }),
      findUnique: async () => ({ ...pages.connection }),
    },
    job: {
      findMany: async ({ where }: any) =>
        pages.jobs
          .filter((j) => j.connectionId === where.connectionId && !(where.missingSince === null && j.missingSince != null))
          .filter((j) => where.estimatedCostSource == null || j.estimatedCostSource === where.estimatedCostSource)
          .map(withRows),
      findUnique: async ({ where }: any) => {
        const j = pages.jobs.find((x) => x.id === where.id);
        return j ? { ...withRows(j), connection: { ...pages.connection, marginTargets: [] } } : null;
      },
    },
    syncRun: { findFirst: async () => null },
    weeklyDigest: { findMany: async () => [] },
    jobType: { findMany: async () => [] },
    jobEstimate: { findMany: async () => pages.estimates },
    costEntry: { aggregate: async () => ({ _sum: { amount: null, quantity: null } }) },
  };
}

/** A job row as the database holds it. Dates are QuickBooks dates (UTC midnight). */
function jobRow(p: {
  id: string;
  status?: string;
  contract?: number | null;
  estimate?: number | null;
  percent?: number | null;
  created?: string;
  costs?: { amount: number; on: string; type?: string; category?: string }[];
  invoices?: { amount: number; on: string }[];
}) {
  return {
    id: p.id, connectionId: "c1", qboId: p.id, parentQboId: null, name: p.id, customerName: null, status: p.status ?? "open", statusOverride: null,
    category: null, estimatedRevenue: p.contract ?? null, manualContractValue: null, estimatedCost: p.estimate ?? null,
    estimatedCostSource: p.estimate != null ? "manual" : null, percentCompleteOverride: p.percent ?? null,
    qboCreatedAt: day(p.created ?? "2026-01-05"), startDate: null, endDate: null, updatedAt: PAGES_NOW, missingSince: null,
    costEntries: (p.costs ?? []).map((c, i) => ({
      id: `${p.id}-c${i}`, category: c.category ?? "materials", description: null, accountName: null, amount: c.amount, txnDate: day(c.on),
      qboSourceType: c.type ?? "Bill", qboSourceId: `${p.id}-c${i}`,
    })),
    invoices: (p.invoices ?? []).map((inv, i) => ({ id: `${p.id}-i${i}`, amount: inv.amount, status: "open", txnDate: day(inv.on), qboSourceType: "Invoice", taxAmount: 0 })),
  };
}

// ---------------------------------------------------------------------------
// F6. Possible duplicates and the Data Issues tile
// ---------------------------------------------------------------------------

describe("F6: possible duplicates leave out crew time and old jobs, and a job is one issue", () => {
  beforeEach(usePagesDb);

  // A three-person crew, same cost rate, 8 hours each, every weekday Oct 1 to 23.
  const crew = () => {
    const out: { amount: number; on: string; type: string; category: string }[] = [];
    for (let d = 1; d <= 23; d++) {
      const on = `2026-10-${String(d).padStart(2, "0")}`;
      if ([0, 6].includes(day(on).getUTCDay())) continue;
      for (let k = 0; k < 3; k++) out.push({ amount: 224, on, type: "TimeActivity", category: "labor" });
    }
    return out;
  };

  it("doesn't flag time entries of the same amount on the same day, and still flags two equal bills", () => {
    const smith = jobRow({ id: "Smith House", costs: [...crew(), { amount: 1_250, on: "2026-10-02" }, { amount: 1_250, on: "2026-10-02" }] });
    expect(findPossibleDuplicateCostEntries([smith as any])).toEqual([{ jobId: "Smith House", jobName: "Smith House", amount: 1_250, date: "2026-10-02" }]);
  });

  it("checks only the open and recent jobs Data Health covers, and counts a completed job with revenue and no costs once", async () => {
    pages.jobs = [
      jobRow({ id: "Smith House", invoices: [{ amount: 20_000, on: "2026-10-10" }], costs: [...crew(), { amount: 1_250, on: "2026-10-02" }, { amount: 1_250, on: "2026-10-02" }] }),
      // Finished in 2019, two $1,250 permits paid on one day.
      jobRow({ id: "Old 2019 job", status: "closed", created: "2019-01-10", invoices: [{ amount: 30_000, on: "2019-04-01" }], costs: [{ amount: 1_250, on: "2019-04-02" }, { amount: 1_250, on: "2019-04-02" }] }),
      // Completed with an invoice and no costs: on two lists, one issue.
      jobRow({ id: "Maple Dr", status: "closed", invoices: [{ amount: 12_000, on: "2026-09-01" }] }),
    ];
    const data = await getConnectionProfitData("c1", PAGES_NOW);
    expect(data.dataHealth.possibleDuplicates).toEqual([{ jobId: "Smith House", jobName: "Smith House", amount: 1_250, date: "2026-10-02" }]);
    expect(data.dataHealth.jobsMissingCosts.map((j) => j.jobId)).toEqual(["Maple Dr"]);
    expect(data.dataHealth.completedJobsWithUnresolvedActivity.map((j) => j.jobId)).toEqual(["Maple Dr"]);
    // Maple Dr once, and Smith House's two bills.
    expect(data.totals.dataIssues).toBe(2);
  });

  it("adds up the tile the same way from the pure parts", () => {
    const ctx: FinancialContext = { now: PAGES_NOW, targetMarginPct: 25, categoryTargetMarginPct: {}, overheadEnabled: false, overheadMethod: null, overheadValue: null, lastSyncedAt: PAGES_NOW };
    const f = computeJobFinancials(
      { id: "c", name: "Maple Dr", customerName: null, status: "closed", category: null, estimatedRevenue: null, estimatedCost: null, startDate: null, endDate: null, updatedAt: PAGES_NOW, costEntries: [], invoices: [{ amount: 12_000, status: "paid", txnDate: day("2026-09-01") }] },
      ctx
    );
    const dh = computeDataHealth([f], PAGES_NOW, {}, null);
    expect([dh.jobsMissingCosts.length, dh.completedJobsWithUnresolvedActivity.length]).toEqual([1, 1]);
    expect(computeDashboardTotals([f], [], dh, 25).dataIssues).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// F7. The job page and the Feed say what the WIP report says
// ---------------------------------------------------------------------------

describe("F7: the job page and the Feed agree with the WIP report and Money Owed on unbilled work", () => {
  beforeEach(usePagesDb);

  const wipReport = async () => {
    const data = await getConnectionProfitData("c1", PAGES_NOW, { statusFilter: "open", asOf: wipReportDay(PAGES_NOW, pages.connection.emailTimezone) });
    return buildWipSchedule(data.lifetimeJobs, PAGES_NOW);
  };

  it("(a) shows what a job entered as 20% complete with no cost estimate needs, not $19,000 of work not billed", async () => {
    pages.jobs = [jobRow({ id: "Oak Ave", contract: 100_000, percent: 20, costs: [{ amount: 9_000, on: "2026-10-20" }], invoices: [{ amount: 1_000, on: "2026-10-05" }] })];
    const job = (await getJobProfitData("Oak Ave", PAGES_NOW))!;
    expect(job.wipAsOf.need).toBe("progress");
    expect(job.wipAsOf.idle).toBe(false);
    const s = await wipReport();
    expect(s.inProgress).toEqual([]);
    expect(s.notScheduled).toEqual([{ jobId: "Oak Ave", jobName: "Oak Ave", needs: "progress" }]);
    // The page shows the need, from these figures, rather than f.wip's $19,000.
    const page = read("app/dashboard/jobs/[jobId]/page.tsx");
    expect(page).toContain("const w = data.wipAsOf.financials;");
    expect(page).toContain("NOT_SCHEDULED_NEED_TEXT[wipNeed]");
    const section = page.slice(page.indexOf('<Section title="Work in Progress">'), page.indexOf("{/* 3. Cost Breakdown */}"));
    expect(section).toContain("w.wip.overUnderBilling");
    expect(section).not.toMatch(/\bf\.wip\b/);
  });

  it("(b) leaves out an invoice dated after today on the job page's WIP figures and in the Feed, as the WIP report does", async () => {
    pages.jobs = [
      jobRow({
        id: "Pine Ct", contract: 100_000, estimate: 80_000, created: "2026-06-01",
        costs: [{ amount: 48_000, on: "2026-10-20" }],
        invoices: [{ amount: 40_000, on: "2026-10-01" }, { amount: 20_000, on: "2026-11-01" }],
      }),
    ];
    const s = await wipReport();
    expect(s.inProgress[0].underBilled).toBe(20_000);

    const job = (await getJobProfitData("Pine Ct", PAGES_NOW))!;
    expect(job.wipAsOf.financials.revenue).toBe(40_000);
    expect(job.wipAsOf.financials.wip!.overUnderBilling).toBe(-20_000);
    expect(job.wipAsOf.need).toBeNull();
    // The rest of the page still has every invoice.
    expect(job.financials.revenue).toBe(60_000);

    const { feed } = await getOpportunityData("c1", PAGES_NOW);
    expect(feed.summary.unbilledWork).toBe(20_000);
    expect(feed.items.find((i) => i.kind === "underbilled")?.impact).toBe(20_000);
  });
});

// ---------------------------------------------------------------------------
// F8. Jobs Below Target and Profit At Risk
// ---------------------------------------------------------------------------

describe("F8: Jobs Below Target and Profit At Risk count completed jobs from the last 12 months only", () => {
  beforeEach(usePagesDb);

  it("leaves out jobs finished below target years ago, on the All and Completed tabs", async () => {
    const done = (id: string, revenue: number, cost: number, on: string) =>
      jobRow({ id, status: "closed", created: `${on.slice(0, 4)}-01-02`, invoices: [{ amount: revenue, on }], costs: [{ amount: cost, on }] });
    pages.jobs = [
      done("2017 job", 120_000, 110_000, "2017-05-01"),
      done("2018 job", 90_000, 80_000, "2018-06-01"),
      done("2019 job", 60_000, 52_000, "2019-03-01"),
      // 22.5% against a 25% target: $1,000 short.
      done("This year's job", 40_000, 31_000, "2026-08-01"),
    ];
    for (const statusFilter of ["all", "closed"] as const) {
      const data = await getConnectionProfitData("c1", PAGES_NOW, { statusFilter });
      expect({ statusFilter, below: data.totals.jobsBelowTarget, atRisk: Math.round(data.totals.profitAtRisk) }).toEqual({ statusFilter, below: 1, atRisk: 1_000 });
      expect([...new Set(data.needsAttention.map((i) => i.jobId))]).toEqual(["This year's job"]);
    }
  });
});

// ---------------------------------------------------------------------------
// F9. Money Owed ages invoices by the company's own day
// ---------------------------------------------------------------------------

describe("F9: Money Owed ages invoices from the company's day, not the UTC instant", () => {
  // 7:30 pm Central on Oct 27, which is 00:30 UTC on Oct 28.
  const now = new Date("2026-10-28T00:30:00Z");
  const inv = (id: string, due: string) => ({ jobId: "j", jobName: "Elm", customerName: null, qboInvoiceId: id, txnDate: day("2026-08-01"), dueDate: day(due), openBalance: 1_000 });

  it("doesn't call an invoice due tomorrow past due, nor one 60 days past due over 60", () => {
    const asOf = wipReportDay(now, "America/Chicago");
    expect(asOf.toISOString()).toBe("2026-10-27T00:00:00.000Z");
    const owed = computeMoneyOwed({ now, asOf, openInvoices: [inv("1", "2026-10-28"), inv("2", "2026-08-28"), inv("3", "2026-10-27")], jobs: [] });
    const byId = new Map(owed.unpaid.jobs[0].invoiceList.map((i) => [i.qboInvoiceId, [i.ageDays, i.notYetDue]]));
    expect(byId.get("1")).toEqual([0, true]);
    expect(byId.get("2")).toEqual([60, false]);
    // Due today: due, not past due.
    expect(byId.get("3")).toEqual([0, false]);
    expect(owed.unpaid.over60).toBe(0);
  });

  it("ages by whole calendar days without an as-of day, as before", () => {
    const owed = computeMoneyOwed({ now: new Date("2026-10-27T16:00:00Z"), openInvoices: [inv("1", "2026-10-28"), inv("2", "2026-08-28")], jobs: [] });
    const byId = new Map(owed.unpaid.jobs[0].invoiceList.map((i) => [i.qboInvoiceId, [i.ageDays, i.notYetDue]]));
    expect([byId.get("1"), byId.get("2")]).toEqual([[0, true], [60, false]]);
  });
});

// ---------------------------------------------------------------------------
// F10. Estimates priced too low: a customer's options counted once
// ---------------------------------------------------------------------------

describe("F10: good, better and best options for one customer count once in 'Estimates priced too low'", () => {
  const flag = (estimateId: string, customerKey: string | null, shortfall: number): EstimateFeedEntry => ({
    estimateId, label: `Estimate ${estimateId}`, customerKey, shortfall, predictedMarginPct: 0.15, targetMarginPct: 0.25,
    confidence: "medium", confidenceReason: "Based on 3 finished jobs of this type.", notEmailed: false, typeLabel: "Remodel", historyJobs: 3, method: "whole_job",
  });
  const feed = (estimateFlags: EstimateFeedEntry[]) =>
    computeOpportunityFeed({ now: PAGES_NOW, jobs: [] as JobFinancials[], forecasts: new Map(), mixes: new Map(), typeLabel: (k) => k, estimateFlags, estimateCounts: { pending: estimateFlags.length, checked: estimateFlags.length } });

  it("takes the largest shortfall for each customer, keeps every estimate's own item, and says so on the tile", () => {
    const out = feed([flag("101", "57", 3_000), flag("102", "57", 5_000), flag("103", "57", 1_000), flag("104", "60", 2_000)]);
    expect(out.summary.estimatesShortfall).toBe(7_000);
    expect(out.summary.estimatesFlagged).toBe(4);
    expect(out.items.filter((i) => i.kind === "estimate_below_target")).toHaveLength(4);
    expect(estimatesDetail(out.summary)).toBe("4 pending estimates. Options for the same customer are counted once, at the largest.");
  });

  it("adds up estimates for different customers, or with no customer known, as before", () => {
    const out = feed([flag("101", "57", 3_000), flag("104", "60", 2_000), flag("105", null, 1_000), flag("106", null, 500)]);
    expect(out.summary.estimatesShortfall).toBe(6_500);
    expect(out.summary.estimatesAlternatives).toBeUndefined();
    expect(estimatesDetail(out.summary)).toBe("4 pending estimates.");
  });

  it("is told each estimate's customer by the Estimate Check's data", () => {
    expect(read("lib/opportunityData.ts")).toContain("customerKey: e.customerQboId,");
  });
});

// =============================================================================
describe("the corrected figures reach companies already synced", () => {
  // F1 and F4 change rows the sync stores (contract values, and journal
  // entry revenue; F3 was put back as before the audit). Without a version
  // bump a company kept its old rows until its next 30-day full sync.
  it("raises both sync versions to 8, so a company synced under 7 is read in full on its next sync", async () => {
    const { COST_SYNC_VERSION } = await import("../quickbooksSync");
    expect([SYNC_VERSION, COST_SYNC_VERSION]).toEqual([8, 8]);
    const now = Date.UTC(2026, 9, 28, 9);
    expect(fullSyncDue({ lastFullSyncAt: new Date(now - 86_400_000), syncVersion: 7 }, now)).toBe(true);
    expect(fullSyncDue({ lastFullSyncAt: new Date(now - 86_400_000), syncVersion: 8 }, now)).toBe(false);
  });
});

describe("F4 follow-up: Check against QuickBooks names the WIP adjustment as a cause", () => {
  it("lists an accountant's over or under billing entry among the expected causes when revenue differs", async () => {
    const { compareWithQuickBooks } = await import("../qboCheck");
    // Billed $58,000; the CPA's $8,000 adjustment takes QuickBooks' income to $50,000.
    const r = compareWithQuickBooks({ revenue: 58_000, postedCosts: 40_000, timesheetLabor: 0, parentCustomerCosts: 0 }, { income: 50_000, costs: 40_000 });
    expect(r.allMatch).toBe(false);
    expect(r.notes.join(" ")).toContain("over or under billing adjustment your accountant posted to income as a journal entry");
    expect(r.notes.join(" ")).not.toMatch(/[–—]/);
  });
});

// =============================================================================
// Review of the Oct 27 figures fixes
// =============================================================================

import { computeConnectionMetrics, type JobInput } from "../profitability";
import { wipScheduleNeed } from "../wipSchedule";
import { computeBriefHeadline, snapshotFromFeed } from "../briefHeadline";
import { FULL_SYNC_TOO_LONG_MESSAGE } from "../quickbooksSync";

/** A QuickBooks date n days before now (after it, for n below 0). */
const qboDay = (n: number) => new Date(Date.now() - n * DAY).toISOString().slice(0, 10);

/** A fresh in-memory database and pretend QuickBooks for the sync, as F2's. */
function freshSyncDb(data: Record<string, any[]>) {
  qbo.data = data;
  qbo.cdc = {};
  qbo.fail = new Set();
  qbo.cdcSince = [];
  qbo.cdcReachDays = null;
  const c = createFakePrisma() as any;
  c.syncRun = new FakeModel("syncRun", [], () => ({ startedAt: new Date() }));
  c.costEntry = new FakeModel("costEntry");
  c.invoiceSummary = new FakeModel("invoiceSummary");
  c.categoryMapping = new FakeModel("categoryMapping");
  c.jobEstimate = new FakeModel("jobEstimate");
  c.untaggedCost = new FakeModel("untaggedCost");
  db.client = c;
}

async function syncCompany(extra: Record<string, unknown> = {}) {
  const earlier = new Date(Date.now() - 2 * DAY);
  await db.client.quickBooksConnection.create({
    data: {
      id: "c1", userId: "u1", realmId: "realm", realmIdHash: "h1", accessToken: "token", refreshToken: "refresh",
      accessTokenExpiresAt: new Date(Date.now() + 3_600_000), companyName: "Acme Builders", jobSource: "customers",
      laborFromTimeEntries: true, syncVersion: SYNC_VERSION, lastFullSyncAt: earlier, lastSyncedAt: earlier,
      lastSyncAttemptAt: earlier, lastSyncStatus: "success", lastSyncError: null, jobSourceConfirmedAt: new Date(Date.now() - 30 * DAY),
      rebuildRequestedAt: null, basisChangedAt: null, fullSyncContinueAt: null, fullSyncCutShortAt: null,
      ...extra,
    },
  });
}
const syncedConnection = () => db.client.quickBooksConnection.findUnique({ where: { id: "c1" } }) as Promise<any>;
const syncedRows = (qboId: string) => {
  const job = (db.client.job.rows as any[]).find((j) => j.qboId === qboId);
  return (db.client.costEntry.rows as any[]).filter((r) => r.jobId === job?.id);
};
const syncedCost = (qboId: string) => Math.round(syncedRows(qboId).reduce((s, r) => s + Number(r.amount), 0) * 100) / 100;

const cipAccounts = [
  { Id: "13", Name: "Construction in Progress", AccountType: "Other Current Asset", AccountSubType: "OtherCurrentAssets" },
  { Id: "50", Name: "Job Materials", FullyQualifiedName: "Cost of Goods Sold:Job Materials", AccountType: "Cost of Goods Sold", AccountSubType: "SuppliesMaterialsCogs" },
  { Id: "51", Name: "Job Labor", FullyQualifiedName: "Cost of Goods Sold:Job Labor", AccountType: "Cost of Goods Sold", AccountSubType: "CostOfLaborCos" },
  { Id: "35", Name: "Checking", AccountType: "Bank", AccountSubType: "Checking" },
];
const accountRef = (id: string) => ({ value: id, name: cipAccounts.find((a) => a.Id === id)!.FullyQualifiedName ?? cipAccounts.find((a) => a.Id === id)!.Name });
const cipCustomers = [
  { Id: "201", DisplayName: "Smith House", Active: true },
  { Id: "202", DisplayName: "Jones Kitchen", Active: true },
];
/** A bill to Construction in Progress, tagged to a customer and class or to neither. */
const cipBill = (id: string, amount: number, customer?: string, classId?: string) => ({
  Id: id,
  TxnDate: qboDay(120),
  Line: [
    {
      Id: "1",
      Amount: amount,
      DetailType: "AccountBasedExpenseLineDetail",
      AccountBasedExpenseLineDetail: { AccountRef: accountRef("13"), ...(customer ? { CustomerRef: { value: customer } } : {}), ...(classId ? { ClassRef: { value: classId } } : {}) },
    },
  ],
});
const entryLine = (id: string, amount: number, posting: "Debit" | "Credit", accountId: string, customer?: string, classId?: string) => ({
  Id: id,
  Amount: amount,
  JournalEntryLineDetail: {
    PostingType: posting,
    AccountRef: accountRef(accountId),
    ...(customer ? { Entity: { Type: "Customer", EntityRef: { value: customer } } } : {}),
    ...(classId ? { ClassRef: { value: classId } } : {}),
  },
});
const entry = (id: string, daysAgo: number, ...Line: ReturnType<typeof entryLine>[]) => ({ Id: id, TxnDate: qboDay(daysAgo), Line });
/** The CPA's closing entry: debit Job Materials for the job, credit Construction in Progress with no name. */
const closing = (id: string, amount: number, customer = "201") => entry(id, 30, entryLine("0", amount, "Debit", "50", customer), entryLine("1", amount, "Credit", "13"));

describe("review 2: F3 is read as it was before the audit", () => {
  // Each figure here is what d556fc5 gives (checked with the reviewer's
  // f3rev and f3sync scripts against that version).
  async function read3(data: Record<string, any[]>) {
    freshSyncDb({ Account: cipAccounts, Customer: cipCustomers, ...data });
    await syncCompany();
    await runSyncForConnection("c1", { forceFull: true });
    return syncedCost("201");
  }
  const reversal = (id: string, amount: number) => entry(id, 29, entryLine("0", amount, "Debit", "13"), entryLine("1", amount, "Credit", "50", "201"));

  it("both closing lines naming the job: $40,000", async () => {
    expect(
      await read3({ Bill: [cipBill("b1", 40_000, "201")], JournalEntry: [entry("j1", 30, entryLine("0", 40_000, "Debit", "50", "201"), entryLine("1", 40_000, "Credit", "13", "201"))] })
    ).toBe(40_000);
  });

  it("bills to Construction in Progress with no job on them, closed to the job: $40,000", async () => {
    expect(await read3({ Bill: [cipBill("b1", 40_000)], JournalEntry: [closing("j1", 40_000)] })).toBe(40_000);
  });

  it("a close set to reverse the next day, and a deferral into Construction in Progress, read as at d556fc5", async () => {
    // Tagged bills: $40,000 (the bill; the close and its reversal cancel).
    expect(await read3({ Bill: [cipBill("b1", 40_000, "201")], JournalEntry: [closing("j1", 40_000), reversal("j2", 40_000)] })).toBe(40_000);
    // Untagged bills: $0 (the close and its reversal cancel; the bill is on no job).
    expect(await read3({ Bill: [cipBill("b1", 40_000)], JournalEntry: [closing("j1", 40_000), reversal("j2", 40_000)] })).toBe(0);
    // The CPA defers Smith's $30,000 of cost into Construction in Progress with an unnamed debit: $0.
    const cogsBill = { ...cipBill("b2", 30_000, "201"), Line: [{ ...cipBill("b2", 30_000, "201").Line[0], AccountBasedExpenseLineDetail: { AccountRef: accountRef("50"), CustomerRef: { value: "201" } } }] };
    expect(await read3({ Bill: [cogsBill], JournalEntry: [reversal("j1", 30_000)] })).toBe(0);
  });

  it("known limit: bills tagged to the job plus a close naming only the cost line read $80,000", async () => {
    // QuickBooks doesn't require a name on the Construction in Progress line.
    // Telling this apart from untagged bills closed to the job needs a stored
    // Work in Progress balance by job; see the audit doc.
    expect(await read3({ Bill: [cipBill("b1", 40_000, "201")], JournalEntry: [closing("j1", 40_000)] })).toBe(80_000);
  });

  it("has nothing of the rebuilt F3 left", () => {
    for (const f of ["lib/qboNormalize.ts", "lib/quickbooksSync.ts"]) {
      expect({ f, left: /journalWipRelief|WipHeld|relieveWorkInProgress|workInProgressNames|categoryOf/.test(read(f)) }).toEqual({ f, left: false });
    }
  });
});

describe("review: F4 leaves out only the income an over or under billing line balances", () => {
  const lines = (...l: ReturnType<typeof jeLine>[]) => journalRevenueLines(je(...l), lookups).map((x) => [x.customerQboId, x.amount]);

  it("keeps Jones's $2,500 recorded on the same month-end entry as Smith's adjustment", () => {
    expect(lines(jeLine("0", 8_000, "Debit", "40", "201"), jeLine("1", 8_000, "Credit", "25", "201"), jeLine("2", 2_500, "Debit", "11", "202"), jeLine("3", 2_500, "Credit", "40", "202"))).toEqual([["202", 2_500]]);
  });

  it("an adjustment line naming no job offsets the income it balances, by share, and nothing else", () => {
    expect(lines(jeLine("0", 8_000, "Debit", "40", "201"), jeLine("1", 8_000, "Credit", "25"), jeLine("2", 2_500, "Debit", "11", "202"), jeLine("3", 2_500, "Credit", "40", "202"))).toEqual([["202", 2_500]]);
    expect(lines(jeLine("0", 6_000, "Debit", "40", "201"), jeLine("1", 2_000, "Debit", "40", "202"), jeLine("2", 4_000, "Credit", "25"), jeLine("3", 4_000, "Credit", "35"))).toEqual([
      ["201", -3_000],
      ["202", -1_000],
    ]);
  });

  it("an adjustment naming one job leaves another job's income on the entry alone", () => {
    expect(lines(jeLine("0", 5_000, "Debit", "19", "201"), jeLine("1", 5_000, "Credit", "40", "201"), jeLine("2", 900, "Debit", "35"), jeLine("3", 900, "Credit", "40", "202"))).toEqual([["202", 900]]);
  });
});

describe("review: unbilled and over billed work is stated as of the WIP report's day everywhere", () => {
  beforeEach(usePagesDb);
  // Contract $100,000, estimate $80,000: $40,000 spent by today and a $16,000 bill dated next week, $50,000 invoiced.
  const cedar = (on: (n: number) => string) =>
    jobRow({ id: "Cedar Ln", contract: 100_000, estimate: 80_000, created: on(150), costs: [{ amount: 40_000, on: on(7) }, { amount: 16_000, on: on(-9) }], invoices: [{ amount: 50_000, on: on(17) }] });
  const fixedDay = (n: number) => new Date(PAGES_NOW.getTime() - n * DAY).toISOString().slice(0, 10);

  it("Needs Attention on the dashboard and the job page, the alerts' figures, the WIP report and Money Owed all say $0", async () => {
    pages.jobs = [cedar(fixedDay)];
    const asOf = wipReportDay(PAGES_NOW, "America/Chicago");
    const wip = buildWipSchedule((await getConnectionProfitData("c1", PAGES_NOW, { statusFilter: "open", asOf })).lifetimeJobs, PAGES_NOW);
    expect(wip.inProgress.map((r) => r.underBilled)).toEqual([0]);
    // What the alerts read: this call's Needs Attention, and its WIP-day figures to clear one.
    const open = await getConnectionProfitData("c1", PAGES_NOW, { statusFilter: "open" });
    expect(open.needsAttention.filter((i) => i.issueCode === "underbilled")).toEqual([]);
    expect(open.wipAsOf.get("Cedar Ln")!.wip!.overUnderBilling).toBe(0);
    // The dashboard's other figures keep every row, as the Transactions list does.
    expect(open.jobs[0].costs).toBe(56_000);
    const job = (await getJobProfitData("Cedar Ln", PAGES_NOW))!;
    expect(job.needsAttention.filter((i) => i.issueCode === "underbilled")).toEqual([]);
    expect(read("lib/alerts.ts")).toContain('a.kind === "underbilled" && openJobs.has(a.jobId) ? data.wipAsOf.get(a.jobId)');
  });

  it("the brief's job figures, which the AI and top concerns read, say what the WIP report says", async () => {
    // computeConnectionMetrics works out "now" itself, so these dates are around today.
    const realDay = (n: number) => new Date(Date.now() - n * DAY).toISOString().slice(0, 10);
    pages.jobs = [
      cedar(realDay),
      jobRow({ id: "Pine Ct", contract: 100_000, estimate: 80_000, created: realDay(150), costs: [{ amount: 48_000, on: realDay(7) }], invoices: [{ amount: 40_000, on: realDay(26) }, { amount: 20_000, on: realDay(-5) }] }),
    ];
    const metrics = await computeConnectionMetrics("c1", new Date());
    expect(Object.fromEntries(metrics.jobs.map((j) => [j.jobId, j.overUnderBilling]))).toEqual({ "Cedar Ln": 0, "Pine Ct": -20_000 });
    const { feed } = await getOpportunityData("c1", new Date());
    expect(feed.summary.unbilledWork).toBe(20_000);
  });
});

describe("review: F2 never keeps a change-feed start QuickBooks can't reach", () => {
  it("a company back after 40 days whose bills keep failing: one full read, then the change feed again", async () => {
    freshSyncDb({ Account: cipAccounts, Customer: cipCustomers, Bill: [cipBill("b1", 6_000, "201")] });
    qbo.cdcReachDays = 30;
    const old = new Date(Date.now() - 40 * DAY);
    await syncCompany({ lastFullSyncAt: old, lastSyncedAt: old, lastSyncAttemptAt: old });
    qbo.fail.add("Bill");
    const modes: string[] = [];
    for (let i = 0; i < 3; i++) modes.push((await runSyncForConnection("c1")).mode);
    expect(modes).toEqual(["full", "incremental", "incremental"]);
    expect((await syncedConnection()).lastSyncEntitiesUpdated.changeFeedFrom).toBeUndefined();
    expect(qbo.cdcSince.every((d) => Date.now() - d.getTime() < 2 * DAY)).toBe(true);
  });

  it("ignores a stored start older than 29 days", () => {
    const now = Date.UTC(2026, 9, 28, 12);
    const last = new Date(now - DAY);
    const at = (daysAgo: number) => changeFeedStart({ lastSyncedAt: last, lastSyncEntitiesUpdated: { changeFeedFrom: new Date(now - daysAgo * DAY).toISOString() } }, now);
    expect(at(10)).toEqual(new Date(now - 10 * DAY));
    expect(at(29)).toEqual(new Date(now - 29 * DAY));
    expect(at(30)).toEqual(last);
  });
});

describe("review: F2 retries an upgrade read that missed a type, like a first one", () => {
  it("stays on the old version, so the next sync reads in full again, and is accepted after a day", async () => {
    freshSyncDb({ Account: cipAccounts, Customer: cipCustomers, JournalEntry: [] });
    await syncCompany({ syncVersion: SYNC_VERSION - 1 });
    qbo.fail.add("JournalEntry");
    const r = await runSyncForConnection("c1");
    expect(r.mode).toBe("full");
    let c = await syncedConnection();
    expect(c.syncVersion).toBe(SYNC_VERSION - 1);
    expect(fullSyncDue(c)).toBe(true);
    await db.client.quickBooksConnection.update({ where: { id: "c1" }, data: { fullSyncCutShortAt: new Date(Date.now() - 2 * DAY) } });
    await runSyncForConnection("c1");
    c = await syncedConnection();
    expect(c.syncVersion).toBe(SYNC_VERSION);
  });
});

describe("review: a contract value changed by an upgrade counts as a changed figure", () => {
  async function upgrade(estimateAmount: number) {
    freshSyncDb({
      Account: cipAccounts,
      Customer: [{ Id: "21", DisplayName: "Smith House", Active: true }],
      Estimate: [{ Id: "e1", TxnDate: qboDay(40), TotalAmt: estimateAmount, TxnStatus: "Accepted", CustomerRef: { value: "21" } }],
    });
    await syncCompany({ syncVersion: SYNC_VERSION - 1 });
    await db.client.job.create({
      data: { id: "job21", connectionId: "c1", qboId: "21", parentQboId: null, customerName: null, name: "Smith House", status: "open", qboCreatedAt: null, missingSince: null, estimatedRevenue: 25_000, manualContractValue: null },
    });
    await runSyncForConnection("c1");
    return syncedConnection();
  }

  it("marks the upgrade (basisChangedAt) when only a contract value moved, so alerts don't read it as news", async () => {
    const moved = await upgrade(60_000);
    expect(moved.syncVersion).toBe(SYNC_VERSION);
    expect(moved.basisChangedAt).not.toBeNull();
    expect((await upgrade(25_000)).basisChangedAt).toBeNull();
  });
});

describe("review: only this version's read counts toward the part limit", () => {
  it("doesn't call a read stuck for parts of the previous version's read", async () => {
    freshSyncDb({ Account: cipAccounts, Customer: cipCustomers });
    await syncCompany({ lastFullSyncAt: new Date(Date.now() - 40 * DAY), lastSyncedAt: new Date(Date.now() - DAY) });
    for (let i = 7; i >= 1; i--) {
      const at = new Date(Date.now() - i * DAY);
      await db.client.syncRun.create({
        data: { connectionId: "c1", status: "partial", mode: "full", errorMessage: null, startedAt: at, finishedAt: at, entitiesUpdated: { fullSyncProgress: { version: SYNC_VERSION - 1, startedAt: at.toISOString(), done: ["Jobs"] } } },
      });
    }
    const r = await runSyncForConnection("c1", { deadline: Date.now() - 1 });
    expect(r.unfinished).toBe(true);
    expect(r.stuck).toBeUndefined();
    expect((await syncedConnection()).lastSyncError).not.toBe(FULL_SYNC_TOO_LONG_MESSAGE);
  });
});

describe("review: F8 keeps completed jobs that were active in a period picked further back", () => {
  beforeEach(usePagesDb);

  it("Completed tab, 2019: the 2019 job at 13.3% against a 25% target counts", async () => {
    pages.jobs = [jobRow({ id: "2019 job", status: "closed", created: "2019-01-02", invoices: [{ amount: 60_000, on: "2019-03-01" }], costs: [{ amount: 52_000, on: "2019-03-01" }] })];
    const data = await getConnectionProfitData("c1", PAGES_NOW, { statusFilter: "closed", dateRange: { from: day("2019-01-01"), to: day("2019-12-31") } });
    expect([data.totals.jobsBelowTarget, Math.round(data.totals.profitAtRisk)]).toEqual([1, 7_000]);
    // This year's period still leaves it out.
    const thisYear = await getConnectionProfitData("c1", PAGES_NOW, { statusFilter: "closed", dateRange: { from: day("2026-01-01"), to: day("2026-12-31") } });
    expect(thisYear.totals.jobsBelowTarget).toBe(0);
  });
});

describe("review 2: F5 holds a job off the schedule whatever its cost estimate's source", () => {
  const NOW = new Date("2026-10-27T16:00:00Z");
  const ctx: FinancialContext = { now: NOW, targetMarginPct: 25, categoryTargetMarginPct: {}, overheadEnabled: false, overheadMethod: null, overheadValue: null, lastSyncedAt: NOW };

  it("a $75,000 placeholder from the target margin, 90% entered, $37,500 spent, is listed, not shown with $52,500 to date beside $25,000", () => {
    const input: JobInput = {
      id: "j1", name: "Smith", customerName: null, status: "open", category: null, estimatedRevenue: 100_000, estimatedCost: 75_000,
      percentCompleteOverride: 90, qboCreatedAt: new Date("2026-06-01"), startDate: null, endDate: null, updatedAt: NOW,
      costEntries: [{ category: "materials", amount: 37_500, txnDate: new Date("2026-10-01") }], invoices: [{ amount: 50_000, status: "open", txnDate: new Date("2026-10-01") }],
    };
    const s = buildWipSchedule([computeJobFinancials(input, ctx)], NOW, new Set(["j1"]));
    expect(s.inProgress).toEqual([]);
    expect(s.notScheduled).toEqual([{ jobId: "j1", jobName: "Smith", needs: "costs_behind" }]);
  });

  it("the job page says the estimate is a placeholder, and the brief's prompt knows the reason", async () => {
    usePagesDb();
    pages.jobs = [{ ...jobRow({ id: "Birch Rd", contract: 100_000, estimate: 75_000, percent: 90, costs: [{ amount: 37_500, on: "2026-10-10" }], invoices: [{ amount: 50_000, on: "2026-10-12" }] }), estimatedCostSource: "target_margin" }];
    const job = (await getJobProfitData("Birch Rd", PAGES_NOW))!;
    expect([job.wipAsOf.need, job.estimateFromTargetMargin]).toEqual(["costs_behind", true]);
    expect(read("app/dashboard/jobs/[jobId]/page.tsx")).toContain("The cost estimate was filled in from your target margin, so entering your own is likely the fix.");
    expect(read("lib/digest.ts")).toContain("a percent complete entered well ahead of the costs");
    expect(read("lib/wipSchedule.ts")).not.toContain("estimatedCostFromTarget");
  });
});

describe("review: F10's headline says when a customer's options were counted once", () => {
  const flag = (estimateId: string, customerKey: string, shortfall: number): EstimateFeedEntry => ({
    estimateId, label: `Estimate ${estimateId}`, customerKey, shortfall, predictedMarginPct: 0.15, targetMarginPct: 0.25,
    confidence: "medium", confidenceReason: "Based on 3 finished jobs of this type.", notEmailed: false, typeLabel: "Remodel", historyJobs: 3, method: "whole_job",
  });
  const headline = (flags: EstimateFeedEntry[]) =>
    computeBriefHeadline(
      snapshotFromFeed(computeOpportunityFeed({ now: PAGES_NOW, jobs: [], forecasts: new Map(), mixes: new Map(), typeLabel: (k) => k, estimateFlags: flags })),
      null,
      "Acme"
    ).headline;

  it("names the customers, not the estimates, when options were counted once", () => {
    expect(headline([flag("1", "57", 3_000), flag("2", "57", 5_000), flag("3", "57", 1_000), flag("4", "60", 2_000)])).toBe(
      "Pending estimates for 2 customers look $7,000 light against your target margin."
    );
    expect(headline([flag("1", "57", 3_000), flag("4", "60", 2_000)])).toBe("2 pending estimates look $5,000 light against your target margin.");
  });
});

describe("review: the job page gives an idle job's reason first, as the schedule does", () => {
  it("checks idle before past the estimate", () => {
    const page = read("app/dashboard/jobs/[jobId]/page.tsx");
    expect(page.indexOf("w.wip && data.wipAsOf.idle ?")).toBeGreaterThan(-1);
    expect(page.indexOf("w.wip && data.wipAsOf.idle ?")).toBeLessThan(page.indexOf("w.wip?.costPastEstimate ?"));
  });
});

describe("review: the Feed matches estimates to live jobs only, as the sync does", () => {
  beforeEach(usePagesDb);

  it("doesn't put a pending estimate on a job gone from QuickBooks", async () => {
    pages.jobs = [jobRow({ id: "Live" }), { ...jobRow({ id: "Gone" }), missingSince: new Date("2026-09-01") }];
    const pending = (id: string, customerQboId: string) => ({
      id, connectionId: "c1", qboEstimateId: id, customerQboId, amount: 12_000, status: "Pending", txnDate: day("2026-10-15"),
      docNumber: id, customerName: null, emailStatus: null, expirationDate: null, lines: [], jobType: null,
    });
    pages.estimates = [pending("e1", "Live"), pending("e2", "Gone")];
    const { estimates } = await getOpportunityData("c1", PAGES_NOW);
    expect(Object.fromEntries(estimates.map((e) => [e.qboEstimateId, e.jobId]))).toEqual({ e1: "Live", e2: null });
  });
});

// =============================================================================
// Second review of the figures fixes
// =============================================================================

import { isUntaggedJobCost } from "../untaggedCosts";

describe("review 3: Data Health lists an untagged item line into Construction in Progress, as before the audit", () => {
  // The second round left these out of "Job costs not tagged to a job", which
  // moved real untagged job costs into overhead. Put back as at d556fc5; the
  // caveat for a CPA who closes Construction in Progress to jobs is in the
  // audit doc.
  const items = emptyLookups();
  for (const [id, a] of lookups.accounts) items.accounts.set(id, a);
  items.items.set("i1", { name: "Framing package", expenseAccountId: "13" });
  items.items.set("i2", { name: "Lumber", expenseAccountId: "50" });
  const itemLine = (id: string, amount: number, item: string) => ({ Id: id, Amount: amount, DetailType: "ItemBasedExpenseLineDetail", ItemBasedExpenseLineDetail: { ItemRef: { value: item } } });

  it("counts item lines as job cost lines whatever account the item posts to", () => {
    const lines = expenseLines({ Id: "b7", TxnDate: "2026-10-01", Line: [itemLine("1", 12_000, "i1"), itemLine("2", 800, "i2")] }, "Bill", items);
    expect(lines.map((l) => [l.lineId, isUntaggedJobCost(l, "Bill")])).toEqual([
      ["1", true],
      ["2", true],
    ]);
  });

  it("lists both through the sync", async () => {
    freshSyncDb({
      Account: cipAccounts,
      Customer: cipCustomers,
      Item: [
        { Id: "i1", Name: "Framing package", ExpenseAccountRef: { value: "13" } },
        { Id: "i2", Name: "Lumber", ExpenseAccountRef: { value: "50" } },
      ],
      Bill: [{ Id: "b7", TxnDate: qboDay(20), Line: [itemLine("1", 12_000, "i1"), itemLine("2", 800, "i2")] }],
    });
    await syncCompany();
    const r = await runSyncForConnection("c1", { forceFull: true });
    expect([r.untaggedJobCostCount, r.untaggedJobCostAmount]).toEqual([2, 12_800]);
    expect(read("lib/qboNormalize.ts")).not.toContain("intoWorkInProgress");
  });
});

describe("review 2: F4 handles over and under billing lines each in their own direction", () => {
  const f4 = emptyLookups();
  for (const [id, a] of lookups.accounts) f4.accounts.set(id, a);
  f4.accounts.set("26", { name: "Costs in Excess of Billings", fullName: "Costs in Excess of Billings", type: "Other Current Asset", subType: "OtherCurrentAssets" });
  const out = (...l: ReturnType<typeof jeLine>[]) => journalRevenueLines(je(...l), f4).map((x) => [x.customerQboId, x.amount]);

  it("one job over billed and another under billed on one entry, the adjustment lines unnamed: neither changes billed to date", () => {
    expect(out(jeLine("0", 8_000, "Debit", "40", "A"), jeLine("1", 8_000, "Credit", "25"), jeLine("2", 5_000, "Debit", "26"), jeLine("3", 5_000, "Credit", "40", "B"))).toEqual([]);
    expect(out(jeLine("0", 5_000, "Debit", "40", "A"), jeLine("1", 5_000, "Credit", "25"), jeLine("2", 8_000, "Debit", "26"), jeLine("3", 8_000, "Credit", "40", "B"))).toEqual([]);
    expect(out(jeLine("0", 5_000, "Debit", "40", "A"), jeLine("1", 5_000, "Credit", "25"), jeLine("2", 5_000, "Debit", "26"), jeLine("3", 5_000, "Credit", "40", "B"))).toEqual([]);
    // Named, the same.
    expect(out(jeLine("0", 8_000, "Debit", "40", "A"), jeLine("1", 8_000, "Credit", "25", "A"), jeLine("2", 5_000, "Debit", "26", "B"), jeLine("3", 5_000, "Credit", "40", "B"))).toEqual([]);
  });

  it("last month's over billing reversed and this month's booked on one entry: neither is billing", () => {
    expect(out(jeLine("0", 3_000, "Debit", "25"), jeLine("1", 3_000, "Credit", "40", "A"), jeLine("2", 8_000, "Debit", "40", "A"), jeLine("3", 8_000, "Credit", "25"))).toEqual([]);
  });

  it("still counts income no adjustment line balances, in either direction", () => {
    // Jones's $2,500 against A/R beside an over billing adjustment, and beside an under billing one.
    expect(out(jeLine("0", 8_000, "Debit", "40", "A"), jeLine("1", 8_000, "Credit", "25"), jeLine("2", 2_500, "Debit", "11", "202"), jeLine("3", 2_500, "Credit", "40", "202"))).toEqual([["202", 2_500]]);
    expect(out(jeLine("0", 5_000, "Debit", "26"), jeLine("1", 5_000, "Credit", "40", "B"), jeLine("2", 2_500, "Debit", "11", "202"), jeLine("3", 2_500, "Credit", "40", "202"))).toEqual([["202", 2_500]]);
  });
});

describe("review 2: Needs Attention leaves out what the WIP schedule leaves out", () => {
  beforeEach(usePagesDb);
  const lastYear = { from: new Date(PAGES_NOW.getTime() - 365 * DAY), to: PAGES_NOW };

  it("an idle open job, on the dashboard's default 12 months and on its own page, says no work is waiting to be billed", async () => {
    pages.jobs = [
      // Nothing posted since June: off the schedule as idle.
      jobRow({ id: "Quiet Addition", contract: 100_000, estimate: 80_000, costs: [{ amount: 60_000, on: "2026-06-20" }], invoices: [{ amount: 40_000, on: "2026-06-25" }] }),
      jobRow({ id: "Old Deck", contract: 30_000, costs: [{ amount: 28_000, on: "2026-05-20" }], invoices: [{ amount: 30_000, on: "2026-05-30" }] }),
    ];
    const dashboard = await getConnectionProfitData("c1", PAGES_NOW, { dateRange: lastYear, statusFilter: "open" });
    expect(dashboard.needsAttention).toEqual([]);
    const wip = buildWipSchedule((await getConnectionProfitData("c1", PAGES_NOW, { statusFilter: "open", asOf: wipReportDay(PAGES_NOW, "America/Chicago") })).lifetimeJobs, PAGES_NOW);
    expect([wip.idle.map((j) => j.jobId), wip.totals.underBilled]).toEqual([["Quiet Addition"], 0]);
    const page = (await getJobProfitData("Quiet Addition", PAGES_NOW))!;
    expect(page.wipAsOf.idle).toBe(true);
    expect(page.needsAttention.map((i) => i.issueCode)).not.toContain("underbilled");
  });

  it("a completed job active in the picked period still counts, an open one that isn't doesn't", async () => {
    pages.jobs = [jobRow({ id: "2019 job", status: "closed", created: "2019-01-02", invoices: [{ amount: 60_000, on: "2019-03-01" }], costs: [{ amount: 52_000, on: "2019-03-01" }] })];
    const data = await getConnectionProfitData("c1", PAGES_NOW, { statusFilter: "all", dateRange: { from: day("2019-01-01"), to: day("2019-12-31") } });
    expect(data.totals.jobsBelowTarget).toBe(1);
  });
});

// =============================================================================
// Third review of the figures fixes
// =============================================================================

import { getSampleCompany, SAMPLE_NOW } from "../sampleCompany";
import { isInScope } from "../profitability";

describe("review 3: F4 shields only income a sale line balances, and shares what's left fairly", () => {
  const r3 = emptyLookups();
  for (const [id, name, type, sub] of [
    ["40", "Construction Income", "Income", "SalesOfProductIncome"],
    ["25", "Billings in Excess of Costs", "Other Current Liability", "OtherCurrentLiabilities"],
    ["26", "Costs in Excess of Billings", "Other Current Asset", "OtherCurrentAssets"],
    ["27", "Contract Liabilities", "Other Current Liability", "OtherCurrentLiabilities"],
    ["28", "Contract Assets", "Other Current Asset", "OtherCurrentAssets"],
    ["29", "Unbilled Receivables", "Accounts Receivable", "AccountsReceivable"],
    ["30", "Retainage billed", "Other Current Asset", "OtherCurrentAssets"],
    ["11", "Accounts Receivable", "Accounts Receivable", "AccountsReceivable"],
    ["12", "Undeposited Funds", "Other Current Asset", "UndepositedFunds"],
    ["13", "Construction in Progress", "Other Current Asset", "OtherCurrentAssets"],
    ["35", "Checking", "Bank", "Checking"],
    ["50", "Job Materials", "Cost of Goods Sold", "SuppliesMaterialsCogs"],
    ["60", "Accrued Liabilities", "Other Current Liability", "OtherCurrentLiabilities"],
    ["70", "Retainage Receivable", "Other Current Asset", "OtherCurrentAssets"],
  ] as const) r3.accounts.set(id, { name, fullName: name, type, subType: sub });
  const l = (id: string, amount: number, posting: "Debit" | "Credit", acct: string, cust?: string, cls?: string) => ({
    Id: id,
    Amount: amount,
    JournalEntryLineDetail: { PostingType: posting, AccountRef: { value: acct }, ...(cust ? { Entity: { Type: "Customer", EntityRef: { value: cust } } } : {}), ...(cls ? { ClassRef: { value: cls } } : {}) },
  });
  /** Each job's change to billed to date. */
  const billed = (lines: ReturnType<typeof l>[], byClass = false, extra: Record<string, unknown> = {}) => {
    const out: Record<string, number> = {};
    for (const x of journalRevenueLines({ Id: "j", TxnDate: "2026-09-30", Line: lines, ...extra }, r3, byClass, byClass)) {
      const k = (byClass ? x.classQboId : x.customerQboId) ?? "none";
      out[k] = Math.round(((out[k] ?? 0) + x.amount) * 100) / 100;
    }
    return out;
  };

  it("doesn't let cost, Construction in Progress, accrual or retainage lines naming the job shield its income", () => {
    expect(billed([l("0", 40_000, "Debit", "50", "A"), l("1", 40_000, "Credit", "13", "A"), l("2", 8_000, "Debit", "40", "A"), l("3", 8_000, "Credit", "25")])).toEqual({});
    expect(billed([l("0", 5_000, "Debit", "50", "A"), l("1", 5_000, "Credit", "60"), l("2", 3_000, "Debit", "26"), l("3", 3_000, "Credit", "40", "A")])).toEqual({});
    expect(billed([l("0", 1_000, "Debit", "70", "A"), l("1", 1_000, "Credit", "11", "A"), l("2", 3_000, "Debit", "26"), l("3", 3_000, "Credit", "40", "A")])).toEqual({});
  });

  it("still keeps income an A/R, bank or Undeposited Funds line naming the customer balances", () => {
    expect(billed([l("0", 5_000, "Debit", "11", "A"), l("1", 5_000, "Credit", "40", "A"), l("2", 3_000, "Debit", "26"), l("3", 3_000, "Credit", "40", "B")])).toEqual({ A: 5_000 });
    expect(billed([l("0", 5_000, "Debit", "35", "A"), l("1", 5_000, "Credit", "40", "A"), l("2", 3_000, "Debit", "26"), l("3", 3_000, "Credit", "40", "B")])).toEqual({ A: 5_000 });
    expect(billed([l("0", 5_000, "Debit", "12", "A"), l("1", 5_000, "Credit", "40", "A"), l("2", 3_000, "Debit", "26"), l("3", 3_000, "Credit", "40", "B")])).toEqual({ A: 5_000 });
  });

  it("carries the part of a named adjustment that finds none of its job's income to the shared pool", () => {
    // Names the parent customer P; the income names its project A.
    expect(billed([l("0", 8_000, "Debit", "40", "A"), l("1", 8_000, "Credit", "25", "P")])).toEqual({});
    // $8,000 on A's line; the income is $6,000 A and $2,000 B.
    expect(billed([l("0", 6_000, "Debit", "40", "A"), l("1", 2_000, "Debit", "40", "B"), l("2", 8_000, "Credit", "25", "A")])).toEqual({});
  });

  it("nets a reclass between the two adjustment accounts on one job before anything else", () => {
    expect(billed([l("0", 2_000, "Debit", "25", "A"), l("1", 2_000, "Credit", "26", "A"), l("2", 5_000, "Debit", "11", "A"), l("3", 5_000, "Credit", "40", "A")])).toEqual({ A: 5_000 });
  });

  it("in class mode matches an A/R line to income by customer", () => {
    expect(billed([l("0", 5_000, "Debit", "11", "C1"), l("1", 5_000, "Credit", "40", "C1", "K1"), l("2", 3_000, "Debit", "26", "C2"), l("3", 3_000, "Credit", "40", "C2", "K2")], true)).toEqual({ K1: 5_000 });
  });

  it("allocates so the cents add up", () => {
    const lines = [l("0", 100, "Debit", "40", "A"), l("1", 100, "Debit", "40", "A"), l("2", 100, "Debit", "40", "A"), l("3", 100, "Credit", "25"), l("4", 200, "Credit", "35")];
    expect(billed(lines)).toEqual({ A: -200 });
    expect(journalRevenueLines({ Id: "j", TxnDate: "2026-09-30", Line: lines }, r3).map((x) => x.amount).sort((a, b) => a - b)).toEqual([-66.67, -66.67, -66.66]);
    // Other currencies, as before.
    expect(billed([l("0", 1_000, "Debit", "40", "A"), l("1", 400, "Credit", "25"), l("2", 600, "Credit", "35")], false, { ExchangeRate: 1.35, CurrencyRef: { value: "CAD" } })).toEqual({ A: -810 });
  });

  it("knows the ASC 606 names and an unbilled receivable set up as A/R, and not a retainage account", () => {
    expect(billed([l("0", 8_000, "Debit", "40", "A"), l("1", 8_000, "Credit", "27", "A")])).toEqual({});
    expect(billed([l("0", 3_000, "Debit", "28", "A"), l("1", 3_000, "Credit", "40", "A")])).toEqual({});
    expect(billed([l("0", 3_000, "Debit", "29", "A"), l("1", 3_000, "Credit", "40", "A")])).toEqual({});
    // An unbilled receivable is an adjustment account, so it never shields income.
    expect(billed([l("0", 3_000, "Debit", "29", "A"), l("1", 3_000, "Credit", "40", "A"), l("2", 2_000, "Debit", "26"), l("3", 2_000, "Credit", "40", "B")])).toEqual({});
    // Retainage billed by journal entry is billing.
    expect(billed([l("0", 5_000, "Debit", "30", "A"), l("1", 5_000, "Credit", "40", "A")])).toEqual({ A: 5_000 });
    expect(isWipAdjustmentAccount(r3.accounts.get("11"))).toBe(false);
  });
});

describe("review 3: the sample company's Needs Attention judges the jobs the real dashboard does", () => {
  it("leaves out completed jobs the real dashboard's scope leaves out, and the tiles follow", () => {
    const s = getSampleCompany();
    const judged = new Set(s.dashboard.needsAttention.map((i) => i.jobId));
    const outOfScope = s.jobs.filter((f) => !isInScope(f, SAMPLE_NOW) && f.status === "closed");
    expect(outOfScope.length).toBeGreaterThan(0);
    // Completed jobs with no money in the last 12 months (Sutton Reroof and
    // the like) aren't judged, as on the real dashboard.
    expect(outOfScope.filter((f) => judged.has(f.jobId)).map((f) => f.jobName)).toEqual([]);
    const belowTarget = new Set(s.dashboard.needsAttention.filter((i) => i.issueCode === "below_target_margin").map((i) => i.jobId));
    expect([s.dashboard.totals.jobsBelowTarget, s.dashboard.needsAttention.length]).toEqual([belowTarget.size, 18]);
  });
});

describe("review 3: a view-only login isn't told to enter the cost estimate itself", () => {
  it("words the target-margin sentence for the bookkeeper's client", () => {
    const page = read("app/dashboard/jobs/[jobId]/page.tsx");
    expect(page).toContain("The cost estimate was filled in from the target margin, so a real cost estimate is likely the fix.");
    expect(page).toContain("The cost estimate was filled in from your target margin, so entering your own is likely the fix.");
  });
});
