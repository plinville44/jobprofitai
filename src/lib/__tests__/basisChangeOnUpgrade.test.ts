import { describe, it, expect, beforeEach, vi } from "vitest";
import { createFakePrisma, FakeModel, type FakePrisma } from "./support/fakePrisma";

// A full sync that upgrades a company to new sync rules marks its figures
// as worked out on new terms (basisChangedAt) only when figures really
// moved. Marking every upgrade left every tracked pricing change reading
// "can't be compared" for good, and stopped week-over-week comparisons, for
// companies whose figures came out exactly the same.
//
// And an incremental sync that gives a parent customer its first job asks
// for a full sync, so costs tagged to the customer before the project
// existed move onto it within a day (C14).

const fake: { client: FakePrisma } = { client: createFakePrisma() };
vi.mock("@/lib/prisma", () => ({
  get prisma() {
    return fake.client;
  },
}));
vi.mock("@/lib/crypto", () => ({
  encryptToken: (s: string) => s,
  decryptToken: (s: string) => s,
}));

// Payload shapes are trimmed copies of what the QuickBooks Online v3 API returns.
const qbo: { data: Record<string, any[]>; cdc: Record<string, any[]> } = { data: {}, cdc: {} };
vi.mock("@/lib/quickbooks", () => ({
  qboQueryAll: async (_realm: string, _token: string, _query: string, entity: string) => qbo.data[entity] ?? [],
  qboQuery: async () => ({}),
  qboCompanyInfo: async () => ({}),
  qboCdc: async (_realm: string, _token: string, entities: string[]) => ({
    CDCResponse: [{ QueryResponse: entities.filter((e) => qbo.cdc[e]).map((e) => ({ [e]: qbo.cdc[e] })) }],
  }),
  refreshTokens: async () => {
    throw new Error("not expected");
  },
}));

import { COST_SYNC_VERSION, figuresDiffer, rebuildChangedFigures, runSyncForConnection, SYNC_VERSION } from "../quickbooksSync";

const DAY = 86_400_000;

function resetDb() {
  fake.client = createFakePrisma();
  const c = fake.client as any;
  c.syncRun = new FakeModel("syncRun", [], () => ({ startedAt: new Date() }));
  c.costEntry = new FakeModel("costEntry");
  c.invoiceSummary = new FakeModel("invoiceSummary");
  c.categoryMapping = new FakeModel("categoryMapping");
  c.jobEstimate = new FakeModel("jobEstimate");
  c.untaggedCost = new FakeModel("untaggedCost");
}

async function addConnection(jobSource: "customers" | "projects" = "customers") {
  const lastAttempt = new Date(Date.now() - 2 * DAY);
  await fake.client.quickBooksConnection.create({
    data: {
      id: "c1",
      userId: "u1",
      realmId: "realm",
      realmIdHash: "h1",
      accessToken: "token",
      refreshToken: "refresh",
      accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
      jobSource,
      laborFromTimeEntries: false,
      syncVersion: SYNC_VERSION,
      lastFullSyncAt: new Date(Date.now() - 3 * DAY),
      lastSyncedAt: lastAttempt,
      lastSyncAttemptAt: lastAttempt,
      lastSyncStatus: "success",
      jobSourceConfirmedAt: new Date(Date.now() - 30 * DAY),
      rebuildRequestedAt: null,
      basisChangedAt: null,
    },
  });
}

const connection = () => fake.client.quickBooksConnection.findUnique({ where: { id: "c1" } }) as Promise<any>;
const costRows = () => (fake.client as any).costEntry.rows as any[];
const revenueRows = () => (fake.client as any).invoiceSummary.rows as any[];

/** Puts the company back under older rules, as it was before the upgrade. */
async function downgrade() {
  await fake.client.quickBooksConnection.update({
    where: { id: "c1" },
    data: { syncVersion: COST_SYNC_VERSION - 1, basisChangedAt: null, lastSyncStatus: "success" },
  });
}

describe("marking figures as rebuilt after a sync version upgrade", () => {
  beforeEach(async () => {
    resetDb();
    qbo.data = {
      Account: [
        { Id: "80", Name: "Job Materials", AccountType: "Cost of Goods Sold", AccountSubType: "SuppliesMaterialsCogs" },
        { Id: "13", Name: "Construction in Progress", AccountType: "Other Current Asset", AccountSubType: "OtherCurrentAssets" },
        { Id: "40", Name: "Construction Income", AccountType: "Income", AccountSubType: "SalesOfProductIncome" },
      ],
      Customer: [{ Id: "21", DisplayName: "Smith", Active: true }],
      Purchase: [
        {
          Id: "145",
          TxnDate: "2026-09-10",
          Line: [{ Id: "1", Amount: 300, AccountBasedExpenseLineDetail: { AccountRef: { value: "80", name: "Job Materials" }, CustomerRef: { value: "21", name: "Smith" } } }],
        },
      ],
      JournalEntry: [
        {
          Id: "77",
          TxnDate: "2026-09-01",
          Line: [
            { Id: "0", Amount: 1_000, JournalEntryLineDetail: { PostingType: "Debit", AccountRef: { value: "80" }, Entity: { Type: "Customer", EntityRef: { value: "21" } } } },
            { Id: "1", Amount: 1_000, JournalEntryLineDetail: { PostingType: "Credit", AccountRef: { value: "13" }, Entity: { Type: "Customer", EntityRef: { value: "21" } } } },
          ],
        },
      ],
      Invoice: [{ Id: "300", DocNumber: "1042", TxnDate: "2026-09-01", DueDate: "2026-10-01", TotalAmt: 5_000, Balance: 5_000, CustomerRef: { value: "21" } }],
    };
    await addConnection();
    await fake.client.job.create({
      data: {
        id: "job21", connectionId: "c1", qboId: "21", parentQboId: null, customerName: null, name: "Smith", status: "open",
        qboCreatedAt: null, missingSince: null, estimatedCost: null, manualContractValue: null, percentCompleteOverride: null,
        category: null, statusOverride: null, estimatedRevenue: null,
      },
    });
    // A sync under the current rules stores the rows; then the company is
    // put back a version, as a company waiting for the upgrade would be.
    await runSyncForConnection("c1", { forceFull: true });
    expect(costRows().map((r) => r.amount).sort((a, b) => a - b)).toEqual([-1_000, 300, 1_000]);
    await downgrade();
  });

  it("leaves the date alone when the upgrade changed no figures", async () => {
    const r = await runSyncForConnection("c1");
    expect(r.mode).toBe("full");
    expect(r.figureRowsChanged).toBe(0);
    expect((await connection()).basisChangedAt).toBeNull();
    expect((await connection()).syncVersion).toBe(SYNC_VERSION);
  });

  it("doesn't count an invoice number or due date filled in for the first time", async () => {
    for (const row of revenueRows()) Object.assign(row, { docNumber: null, dueDate: null });
    const r = await runSyncForConnection("c1");
    expect(r.revenueRowsUpdated).toBe(1);
    expect((await connection()).basisChangedAt).toBeNull();
    expect(revenueRows()[0].docNumber).toBe("1042");
  });

  it("marks it when a stored amount changed", async () => {
    costRows().find((r) => r.qboSourceType === "Purchase").amount = 250;
    await runSyncForConnection("c1");
    expect((await connection()).basisChangedAt).toBeInstanceOf(Date);
  });

  it("marks it when a line of a stored transaction is counted for the first time", async () => {
    // The old rules didn't count the Construction in Progress credit.
    (fake.client as any).costEntry.rows = costRows().filter((r) => r.amount !== -1_000);
    const r = await runSyncForConnection("c1");
    expect(r.figureRowsChanged).toBe(1);
    expect((await connection()).basisChangedAt).toBeInstanceOf(Date);
  });

  it("marks it when rows are removed", async () => {
    await fake.client.job.create({ data: { id: "jobX", connectionId: "c1", qboId: "99", parentQboId: null, name: "Old", status: "closed", missingSince: null } });
    (fake.client as any).costEntry.rows.push({
      id: "c1:Bill:9:1", jobId: "jobX", qboSourceType: "Bill", qboSourceId: "9", amount: 50, category: "materials",
      txnDate: new Date("2026-08-01T00:00:00Z"), description: null, attributionMethod: "direct", accountName: null, quantity: null,
    });
    const r = await runSyncForConnection("c1");
    expect(r.costRowsRemoved).toBe(1);
    expect((await connection()).basisChangedAt).toBeInstanceOf(Date);
  });

  it("never marks a sync of a company already on the current rules", async () => {
    await fake.client.quickBooksConnection.update({ where: { id: "c1" }, data: { syncVersion: SYNC_VERSION } });
    costRows().find((r) => r.qboSourceType === "Purchase").amount = 250;
    await runSyncForConnection("c1", { forceFull: true });
    expect((await connection()).basisChangedAt).toBeNull();
  });
});

describe("what counts as a change of figures", () => {
  it("is the amount or the job, nothing else", () => {
    expect(figuresDiffer({ jobId: "a", amount: 100 }, { jobId: "a", amount: 100.004 })).toBe(false);
    expect(figuresDiffer({ jobId: "a", amount: 100 }, { jobId: "a", amount: 100.01 })).toBe(true);
    expect(figuresDiffer({ jobId: "a", amount: 100 }, { jobId: "b", amount: 100 })).toBe(true);
  });

  it("reads the sync's counts, and takes counts without the figure to have changed", () => {
    expect(rebuildChangedFigures({ figureRowsChanged: 0, costRowsRemoved: 0, revenueRowsRemoved: 0, revenueRowsUpdated: 40 })).toBe(false);
    expect(rebuildChangedFigures({ figureRowsChanged: 2, costRowsRemoved: 0, revenueRowsRemoved: 0 })).toBe(true);
    expect(rebuildChangedFigures({ figureRowsChanged: 0, costRowsRemoved: 0, revenueRowsRemoved: 3 })).toBe(true);
    expect(rebuildChangedFigures({ costRowsRemoved: 0 })).toBe(true);
  });
});

describe("a parent customer that gets its first job (C14)", () => {
  beforeEach(async () => {
    resetDb();
    qbo.data = { Account: [] };
    await addConnection("projects");
    // Smith has one project already; Jones has none yet.
    await fake.client.job.create({
      data: { id: "job101", connectionId: "c1", qboId: "101", parentQboId: "10", customerName: "Smith", name: "Deck", status: "open", missingSince: null },
    });
  });

  const project = { Id: "301", DisplayName: "Kitchen", Job: true, Active: true, ParentRef: { value: "30", name: "Jones" } };

  it("asks for a full sync, so costs tagged to the customer before the project existed move onto it", async () => {
    qbo.cdc = { Customer: [project] };
    const r = await runSyncForConnection("c1");
    expect(r.mode).toBe("incremental");
    expect(r.fullSyncRequested).toBe(true);
    expect((await connection()).lastFullSyncAt).toBeNull();
  });

  it("doesn't when the customer itself is new since the last sync", async () => {
    const created = new Date(Date.now() - 60_000).toISOString();
    qbo.cdc = { Customer: [{ Id: "30", DisplayName: "Jones", Active: true, MetaData: { CreateTime: created } }, project] };
    const r = await runSyncForConnection("c1");
    expect(r.fullSyncRequested).toBeUndefined();
    expect((await connection()).lastFullSyncAt).toBeInstanceOf(Date);
  });

  it("still asks when a parent's only job stops being its only job", async () => {
    qbo.cdc = { Customer: [{ Id: "102", DisplayName: "Porch", Job: true, Active: true, ParentRef: { value: "10", name: "Smith" } }] };
    const r = await runSyncForConnection("c1");
    expect(r.fullSyncRequested).toBe(true);
  });
});
