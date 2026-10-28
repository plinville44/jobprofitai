import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { createFakePrisma, FakeModel, type FakePrisma } from "./support/fakePrisma";

// The sync fixes from the audit of Oct 19, 2026, run through the real sync
// against a pretend QuickBooks whose payloads are trimmed copies of what the
// QuickBooks Online v3 API returns.
//
//  1. A repeat client's first project took on the client's whole history.
//  2. A first sync that stopped partway was shown as finished.
//  3. A full sync deleted stored rows a paged read happened to miss.
//  4. Revenue on no job disappeared without a count.
//  5. Amounts in another currency were counted as home currency.
//  6. In class mode a credit line's class made another class's balance too big.
//  7. A project moved to another customer kept the old customer's costs.
//  8. The first-run screen's "no jobs" words, and the automatic switch to one
//     customer per job, which nobody was told about.

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

const qbo: { data: Record<string, any[]>; cdc: Record<string, any[]>; counts: Record<string, number>; fail: Set<string> } = { data: {}, cdc: {}, counts: {}, fail: new Set() };
vi.mock("@/lib/quickbooks", () => ({
  qboQueryAll: async (_realm: string, _token: string, _query: string, entity: string) => {
    if (qbo.fail.has(entity)) throw new Error("QuickBooks API query failed with status 500");
    return qbo.data[entity] ?? [];
  },
  // SELECT COUNT(*): what QuickBooks says there are, which a test can set higher than what the read returns.
  qboQuery: async (_realm: string, _token: string, query: string) => {
    const entity = /FROM\s+(\w+)/i.exec(query)?.[1] ?? "";
    return { QueryResponse: { totalCount: qbo.counts[entity] ?? (qbo.data[entity] ?? []).length } };
  },
  qboCompanyInfo: async () => ({}),
  qboCdc: async (_realm: string, _token: string, entities: string[]) => ({
    CDCResponse: [{ QueryResponse: entities.filter((e) => qbo.cdc[e]).map((e) => ({ [e]: qbo.cdc[e] })) }],
  }),
  refreshTokens: async () => {
    throw new Error("not expected");
  },
  needsReconnect: (message: string | null | undefined) => (message ?? "").startsWith("Your QuickBooks connection has expired"),
}));
// FirstRunSetup is a client component: only its sync loop is tested here.
vi.mock("react", () => ({ useEffect: () => {}, useRef: () => ({ current: false }), useState: (v: any) => [typeof v === "function" ? v() : v, () => {}] }));
vi.mock("react/jsx-runtime", () => ({ jsx: () => null, jsxs: () => null, Fragment: "fragment" }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));

import {
  COST_SYNC_VERSION,
  FULL_SYNC_STEPS,
  FULL_SYNC_TOO_LONG_MESSAGE,
  runSyncForConnection,
  SYNC_VERSION,
} from "../quickbooksSync";
import {
  buildJobIndex,
  ESTIMATE_PARENT_FALLBACK_GRACE_DAYS,
  depositCostLines,
  depositRevenueLines,
  emptyLookups,
  estimateFromTxn,
  exchangeRate,
  expenseLines,
  expenseRevenueLines,
  journalRevenueLines,
  PARENT_FALLBACK_GRACE_DAYS,
  parentFallbackCovers,
  parentsNeedingFullSync,
  resolveJob,
  revenueByClass,
  revenueFromTxn,
  timeActivityCost,
} from "../qboNormalize";
import { fullSyncContinuable, SYNC_COOLDOWN_SECONDS, syncCooldownSecondsLeft } from "../syncCooldown";
import { FULL_SYNC_OWED_AT, FULL_SYNC_PARTWAY_FIRST_AT, fullSyncOwed, fullSyncPartway, fullSyncTooLong, syncProblemFor } from "../syncProblem";
import { fullSyncDue, holdFullSyncForSkippedCompany } from "../quickbooksSync";
import { unmatchedRevenueFrom } from "../untaggedCosts";
import { loadUnmatchedRevenue } from "../untaggedCostStore";
import { FIRST_RUN_MAX_SYNC_CALLS, runFirstSync, SWITCHED_TO_CUSTOMERS_NOTICE } from "../../components/dashboard/FirstRunSetup";

const DAY = 86_400_000;
const HOUR = 3_600_000;
/** A QuickBooks date n days before now. */
const dayStr = (n: number) => new Date(Date.now() - n * DAY).toISOString().slice(0, 10);
const tick = () => new Promise((resolve) => setTimeout(resolve, 3));
const noTimeLeft = () => Date.now() - 1;
const plentyOfTime = () => Date.now() + HOUR;

function resetDb() {
  qbo.fail = new Set();
  fake.client = createFakePrisma();
  const c = fake.client as any;
  c.syncRun = new FakeModel("syncRun", [], () => ({ startedAt: new Date() }));
  c.costEntry = new FakeModel("costEntry");
  c.invoiceSummary = new FakeModel("invoiceSummary");
  c.categoryMapping = new FakeModel("categoryMapping");
  c.jobEstimate = new FakeModel("jobEstimate");
  c.untaggedCost = new FakeModel("untaggedCost");
}

async function addConnection(extra: Record<string, unknown> = {}) {
  const earlier = new Date(Date.now() - 2 * DAY);
  await fake.client.quickBooksConnection.create({
    data: {
      id: "c1", userId: "u1", realmId: "realm", realmIdHash: "h1", accessToken: "token", refreshToken: "refresh",
      accessTokenExpiresAt: new Date(Date.now() + HOUR), companyName: "Acme Builders", jobSource: "projects",
      laborFromTimeEntries: true, syncVersion: SYNC_VERSION, lastFullSyncAt: earlier, lastSyncedAt: earlier,
      lastSyncAttemptAt: earlier, lastSyncStatus: "success", lastSyncError: null, jobSourceConfirmedAt: new Date(Date.now() - 30 * DAY),
      rebuildRequestedAt: null, basisChangedAt: null, fullSyncContinueAt: null, fullSyncCutShortAt: null,
      ...extra,
    },
  });
}

const connection = () => fake.client.quickBooksConnection.findUnique({ where: { id: "c1" } }) as Promise<any>;
const db = () => fake.client as any;
const jobByQboId = (qboId: string) => (db().job.rows as any[]).find((j) => j.qboId === qboId);
const costsOn = (jobId: string) => (db().costEntry.rows as any[]).filter((r) => r.jobId === jobId);
const revenueOn = (jobId: string) => (db().invoiceSummary.rows as any[]).filter((r) => r.jobId === jobId);

const accounts = [
  { Id: "80", Name: "Job Materials", AccountType: "Cost of Goods Sold", AccountSubType: "SuppliesMaterialsCogs" },
  { Id: "40", Name: "Construction Income", AccountType: "Income", AccountSubType: "SalesOfProductIncome" },
  { Id: "35", Name: "Checking", AccountType: "Bank", AccountSubType: "Checking" },
];
const costLine = (id: string, amount: number, customer: string | null) => ({
  Id: id,
  Amount: amount,
  DetailType: "AccountBasedExpenseLineDetail",
  AccountBasedExpenseLineDetail: { AccountRef: { value: "80", name: "Job Materials" }, ...(customer ? { CustomerRef: { value: customer } } : {}) },
});
const created = (daysAgo: number) => ({ CreateTime: new Date(Date.now() - daysAgo * DAY).toISOString(), LastUpdatedTime: new Date(Date.now() - daysAgo * DAY).toISOString() });

// ---------------------------------------------------------------------------
// 1. A repeat client's first project
// ---------------------------------------------------------------------------

/**
 * Lena Park has been a client for years, with her old jobs kept on the
 * customer itself. Her new project "Bathroom 2026" was created five days ago:
 * contract $15,000, its own $2,000 of cost and a $5,000 invoice.
 */
function repeatClient() {
  qbo.data = {
    Account: accounts,
    Customer: [
      { Id: "50", DisplayName: "Lena Park", Active: true, MetaData: created(1100) },
      { Id: "51", DisplayName: "Bathroom 2026", Job: true, ParentRef: { value: "50", name: "Lena Park" }, Active: true, MetaData: created(5) },
      // A project with no creation time on it: matched as before.
      { Id: "60", DisplayName: "Omar Diaz", Active: true },
      { Id: "61", DisplayName: "Diaz Garage", Job: true, ParentRef: { value: "60", name: "Omar Diaz" }, Active: true },
    ],
    Invoice: [
      // Two years ago, on the customer: an earlier job's.
      { Id: "900", TxnDate: dayStr(730), TotalAmt: 40_000, Balance: 0, CustomerRef: { value: "50" } },
      // Six months ago, on the customer: not this project's either, and counted.
      { Id: "905", TxnDate: dayStr(180), TotalAmt: 3_000, Balance: 0, CustomerRef: { value: "50" } },
      { Id: "909", TxnDate: dayStr(2), TotalAmt: 5_000, Balance: 5_000, CustomerRef: { value: "51" } },
    ],
    Bill: [
      { Id: "901", TxnDate: dayStr(730), Line: [costLine("1", 28_000, "50")] },
      { Id: "904", TxnDate: dayStr(180), Line: [costLine("1", 1_200, "50")] },
      { Id: "910", TxnDate: dayStr(730), Line: [costLine("1", 999, "60")] },
    ],
    Purchase: [
      { Id: "902", TxnDate: dayStr(3), Line: [costLine("1", 2_000, "51")] },
      // Materials bought 30 days before the project was set up: within the grace.
      { Id: "903", TxnDate: dayStr(35), Line: [costLine("1", 500, "50")] },
    ],
    TimeActivity: [
      { Id: "908", TxnDate: dayStr(730), NameOf: "Employee", EmployeeRef: { value: "e1", name: "Sam" }, CustomerRef: { value: "50" }, Hours: 10, Minutes: 0, CostRate: 30 },
    ],
    Estimate: [
      // Bid on the customer three months before the project was set up, as
      // estimates usually are: it's the project's contract all the same.
      { Id: "907", TxnDate: dayStr(90), TotalAmt: 15_000, TxnStatus: "Accepted", CustomerRef: { value: "50" } },
      // An earlier job's, two years back: not this project's contract.
      { Id: "911", TxnDate: dayStr(760), TotalAmt: 40_000, TxnStatus: "Closed", CustomerRef: { value: "50" } },
    ],
  };
}

describe("1. a transaction on a parent customer goes on its only job only if it isn't from well before that job", () => {
  beforeEach(() => {
    resetDb();
    qbo.cdc = {};
    qbo.counts = {};
  });

  it("takes a parent-tagged transaction from up to 60 days before the job was created, and nothing older", () => {
    expect(PARENT_FALLBACK_GRACE_DAYS).toBe(60);
    const createdAt = new Date("2026-05-01T15:00:00Z");
    expect(parentFallbackCovers(createdAt, new Date("2026-03-02T00:00:00Z"))).toBe(true);
    expect(parentFallbackCovers(createdAt, new Date("2026-03-01T00:00:00Z"))).toBe(false);
    expect(parentFallbackCovers(createdAt, new Date("2026-09-01T00:00:00Z"))).toBe(true);
    // No creation date known: as before.
    expect(parentFallbackCovers(null, new Date("2016-01-01T00:00:00Z"))).toBe(true);

    const index = buildJobIndex([{ id: "j51", qboId: "51", parentQboId: "50", qboCreatedAt: createdAt }]);
    expect(resolveJob(index, "50", new Date("2026-04-15T00:00:00Z"))).toEqual({ jobId: "j51", method: "parent_customer_fallback" });
    expect(resolveJob(index, "50", new Date("2024-04-15T00:00:00Z"))).toBeNull();
    // Tagged to the job itself, any date.
    expect(resolveJob(index, "51", new Date("2020-01-01T00:00:00Z"))).toEqual({ jobId: "j51", method: "direct" });
    // A caller with no date gets the old rule.
    expect(resolveJob(index, "50")).toEqual({ jobId: "j51", method: "parent_customer_fallback" });
    // Estimates: a year before the job, not 60 days.
    expect(ESTIMATE_PARENT_FALLBACK_GRACE_DAYS).toBe(365);
    expect(resolveJob(index, "50", new Date("2025-05-01T00:00:00Z"), ESTIMATE_PARENT_FALLBACK_GRACE_DAYS)).toEqual({ jobId: "j51", method: "parent_customer_fallback" });
    expect(resolveJob(index, "50", new Date("2025-04-30T00:00:00Z"), ESTIMATE_PARENT_FALLBACK_GRACE_DAYS)).toBeNull();
  });

  it("matches estimates the same way wherever they're put on jobs", () => {
    const src = (f: string) => readFileSync(join(__dirname, "..", f), "utf8");
    for (const f of ["quickbooksSync.ts", "opportunityData.ts", "jobTypeSuggestions.ts"]) {
      // One shared rule since the Oct 27 audit (estimatesByJob, which dates parent matches with ESTIMATE_PARENT_FALLBACK_GRACE_DAYS).
      expect({ f, dated: src(f).includes("estimatesByJob(index, ") }).toEqual({ f, dated: true });
    }
    // The creation date the grace counts from is read with the jobs.
    expect(src("opportunityData.ts")).toMatch(/missingSince: true, qboCreatedAt: true/);
    expect(src("jobTypeSuggestions.ts")).toMatch(/parentQboId: true, qboCreatedAt: true/);
  });

  it("shows the new project only its own revenue and cost, not the client's history, and keeps the estimate made before it", async () => {
    repeatClient();
    await addConnection();
    const r = await runSyncForConnection("c1", { forceFull: true });
    const bath = jobByQboId("51");
    expect(costsOn(bath.id).map((c) => [c.qboSourceType, c.qboSourceId, Number(c.amount), c.attributionMethod]).sort()).toEqual([
      ["Purchase", "902", 2_000, "direct"],
      ["Purchase", "903", 500, "parent_customer_fallback"],
    ]);
    expect(revenueOn(bath.id).map((i) => [i.qboInvoiceId, Number(i.amount)])).toEqual([["909", 5_000]]);
    // Estimates get a year's grace, not 60 days: the one bid 90 days before
    // the project counts, the 760-day-old one doesn't ($55,000 if it did).
    expect(bath.estimatedRevenue).toBe(15_000);
    // A project whose creation time QuickBooks didn't send takes them as before.
    expect(costsOn(jobByQboId("61").id).map((c) => [c.qboSourceId, Number(c.amount)])).toEqual([["910", 999]]);

    // Data Health: what still matched through the parent, and what's now on
    // no job, in the last 12 months (the two-year-old ones are past it).
    expect([r.costsMatchedViaParentCount, r.costsMatchedViaParentAmount]).toEqual([2, 1_499]);
    expect([r.unresolvedExpenseCount, r.unresolvedExpenseAmount]).toEqual([1, 1_200]);
    expect([r.unresolvedRevenueCount, r.unresolvedRevenueAmount]).toEqual([1, 3_000]);
  });

  it("moves the old rows off the project on the upgrade sync every company gets", async () => {
    // 7 on Oct 19; later versions keep the rule (8 on Oct 27).
    expect(SYNC_VERSION).toBeGreaterThanOrEqual(7);
    expect(COST_SYNC_VERSION).toBeGreaterThanOrEqual(7);
    repeatClient();
    // As version 6 left it: the client's history on the project.
    await addConnection({ syncVersion: 6 });
    await db().job.create({
      data: { id: "jobBath", connectionId: "c1", qboId: "51", parentQboId: "50", customerName: "Lena Park", name: "Bathroom 2026", status: "open", qboCreatedAt: null, missingSince: null },
    });
    const stored = { jobId: "jobBath", category: "materials", accountName: "Job Materials", description: null, quantity: null, attributionMethod: "parent_customer_fallback" };
    await db().costEntry.create({ data: { ...stored, id: "c1:Bill:901:1", qboSourceType: "Bill", qboSourceId: "901", amount: 28_000, txnDate: new Date(`${dayStr(730)}T00:00:00Z`) } });
    await db().costEntry.create({ data: { ...stored, id: "c1:TimeActivity:908:0", qboSourceType: "TimeActivity", qboSourceId: "908", amount: 300, category: "labor", quantity: 10, txnDate: new Date(`${dayStr(730)}T00:00:00Z`) } });
    await db().invoiceSummary.create({
      data: { id: "c1:Invoice:900", jobId: "jobBath", qboSourceType: "Invoice", qboInvoiceId: "900", amount: 40_000, taxAmount: 0, status: "paid", txnDate: new Date(`${dayStr(730)}T00:00:00Z`), openBalance: null, docNumber: null, dueDate: null },
    });

    // The nightly sync: a full one, because the rules changed.
    const r = await runSyncForConnection("c1");
    expect(r.mode).toBe("full");
    expect(costsOn("jobBath").map((c) => c.qboSourceId).sort()).toEqual(["902", "903"]);
    expect(revenueOn("jobBath").map((i) => i.qboInvoiceId)).toEqual(["909"]);
    const c = await connection();
    expect(c.syncVersion).toBe(SYNC_VERSION);
    // The figures moved for a reason other than work in QuickBooks: marked, so the brief doesn't call it a change on the job.
    expect(c.basisChangedAt).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. A first sync that stops partway
// ---------------------------------------------------------------------------

describe("2. a first sync that stops partway", () => {
  beforeEach(async () => {
    resetDb();
    qbo.cdc = {};
    qbo.counts = {};
    repeatClient();
    // Never synced; the job setup was confirmed, so nothing switches.
    await addConnection({ syncVersion: 1, lastFullSyncAt: null, lastSyncedAt: null, lastSyncAttemptAt: null, lastSyncStatus: null });
  });

  /** POST /api/quickbooks/sync as the route runs it: Sync now's pause first, then a full read with a deadline. */
  const route = (deadlineFor: (call: number) => number) => {
    const seen = { calls: 0, paused: 0, responses: [] as any[] };
    const post = async () => {
      await tick();
      seen.calls++;
      const c = await connection();
      const lastRun = await db().syncRun.findFirst({ where: { connectionId: "c1" }, orderBy: { startedAt: "desc" } });
      const wait = syncCooldownSecondsLeft({ ...c, lastSyncStartedAt: lastRun?.startedAt ?? null });
      if (wait > 0) {
        seen.paused++;
        return { ok: false, data: { error: "This company finished syncing less than a minute ago.", code: "sync_cooldown", retryAfterSeconds: wait } };
      }
      const data = await runSyncForConnection("c1", { forceFull: true, deadline: deadlineFor(seen.calls), resumeWithinMs: HOUR });
      seen.responses.push(data);
      return { ok: true, data };
    };
    return { post, seen };
  };

  it("says how far it got, and isn't held back by Sync now's pause while it carries on", async () => {
    const { post, seen } = route((call) => (call <= 2 ? noTimeLeft() : plentyOfTime()));
    const progress: { step: number; of: number }[] = [];
    const waits: number[] = [];
    const outcome = await runFirstSync(post, (p) => progress.push(p), { wait: async (ms) => void waits.push(ms) });

    expect(seen.responses[0]).toMatchObject({ unfinished: true, remaining: FULL_SYNC_STEPS.slice(1), steps: 12 });
    expect(progress).toEqual([{ step: 2, of: 12 }, { step: 3, of: 12 }]);
    expect(seen.paused).toBe(0);
    expect(waits).toEqual([]);
    expect(outcome).toEqual({ kind: "finished", jobs: 2, switched: false });
    const c = await connection();
    expect(c.fullSyncContinueAt).toBeNull();
    expect(c.syncVersion).toBe(SYNC_VERSION);
  });

  it("puts a note on every dashboard page while the read is partway, and takes it off when it's done", async () => {
    await runSyncForConnection("c1", { forceFull: true, deadline: noTimeLeft(), resumeWithinMs: HOUR });
    const c = await connection();
    // Still recorded as a success: it didn't fail, it isn't finished.
    expect(c.lastSyncStatus).toBe("success");
    expect(fullSyncPartway(c)).toBe(true);
    expect(fullSyncContinuable(c)).toBe(true);
    const owner = syncProblemFor(c, { paused: false, role: "owner" });
    expect(owner).toEqual({
      tone: "warning",
      message:
        "We're still reading Acme Builders's QuickBooks history, so the figures here may be incomplete: some jobs can show costs before their invoices are read. It carries on automatically, usually overnight, or use Sync now on the Dashboard to carry on now.",
      link: null,
    });
    expect(syncProblemFor(c, { paused: false, role: "client" })!.message).not.toContain("Sync now");
    // A company already synced before gets the same note in its own words.
    expect(syncProblemFor({ ...c, lastSyncedAt: new Date() }, { paused: false, role: "owner" })!.message).toContain(
      "We're partway through reading Acme Builders's QuickBooks data in full"
    );

    await tick();
    await runSyncForConnection("c1", { forceFull: true, deadline: plentyOfTime(), resumeWithinMs: HOUR });
    const done = await connection();
    expect(fullSyncPartway(done)).toBe(false);
    expect(syncProblemFor(done, { paused: false, role: "owner" })).toBeNull();
  });

  it("stops pressing once the read is down to once a day, and the note becomes the plain error", async () => {
    const { post, seen } = route(() => noTimeLeft());
    const outcome = await runFirstSync(post, () => {}, { wait: async () => {} });
    // One step a run: the eighth run is the one that puts it on once a day.
    expect(seen.calls).toBe(8);
    expect(seen.responses.at(-1)).toMatchObject({ unfinished: true, stuck: true });
    expect(outcome).toEqual({ kind: "unfinished", jobs: 2, switched: false });
    const c = await connection();
    expect(c.lastSyncError).toBe(FULL_SYNC_TOO_LONG_MESSAGE);
    expect(fullSyncTooLong(c)).toBe(true);
    expect(fullSyncPartway(c)).toBe(false);
    // Its next try is tomorrow: Sync now's pause applies again.
    expect(syncCooldownSecondsLeft({ ...c, lastSyncStartedAt: new Date() })).toBeGreaterThan(0);
    expect(syncProblemFor(c, { paused: false, role: "owner" })!.message).toContain("keeps running out of time");
  });
});

describe("2. a full read that's owed isn't partway", () => {
  beforeEach(async () => {
    resetDb();
    qbo.cdc = {};
    qbo.counts = {};
    repeatClient();
  });

  it("when the change feed fails: owed, first in line, and nothing is held", async () => {
    await addConnection();
    qbo.cdc = {};
    const realCdc = qbo.cdc;
    // The change feed failing, as the nightly job's other workers meet it.
    qbo.cdc = new Proxy(realCdc, { get: () => { throw new Error("Change Data Capture failed"); } }) as any;
    await expect(runSyncForConnection("c1", { deferFullSync: true })).rejects.toThrow();
    qbo.cdc = realCdc;
    const c = await connection();
    expect(c.fullSyncContinueAt).toEqual(FULL_SYNC_OWED_AT);
    expect([fullSyncOwed(c), fullSyncPartway(c), fullSyncDue(c)]).toEqual([true, false, true]);
    expect(syncProblemFor(c, { paused: false, role: "owner" })).toBeNull();
  });

  it("when it's put off late in a window: owed if nothing was read, partway if a step was", async () => {
    await addConnection({ syncVersion: SYNC_VERSION - 1 });
    const late = { deadline: Date.now() - 10_000, windowStart: Date.now() - 60_000 };
    const owed = await runSyncForConnection("c1", late);
    expect(owed).toMatchObject({ unfinished: true, deferred: true });
    expect((await connection()).fullSyncContinueAt).toEqual(FULL_SYNC_OWED_AT);

    // One step read, then put off.
    await runSyncForConnection("c1", { deadline: noTimeLeft() });
    await tick();
    await runSyncForConnection("c1", { deadline: Date.now() - 10_000, windowStart: Date.now() - 60_000 });
    const c = await connection();
    expect(c.fullSyncContinueAt).toEqual(FULL_SYNC_PARTWAY_FIRST_AT);
    expect([fullSyncOwed(c), fullSyncPartway(c)]).toEqual([false, true]);
  });

  it("when its first try fails before reading anything: still owed, retried like any failed sync", async () => {
    await addConnection({ fullSyncContinueAt: FULL_SYNC_OWED_AT });
    qbo.fail.add("Customer");
    await expect(runSyncForConnection("c1", { deadline: plentyOfTime() })).rejects.toThrow();
    const c = await connection();
    expect(c.lastSyncStatus).toBe("error");
    expect(c.fullSyncContinueAt).toBeNull();
    // Owed all the same: the next sync is a full one.
    expect(c.lastFullSyncAt).toBeNull();
    expect([fullSyncPartway(c), fullSyncDue(c)]).toEqual([false, true]);
  });

  it("keeps a partway read partway when it's put off and its saved progress no longer applies", async () => {
    // Partway since yesterday, under the previous rules: its progress can't be carried on.
    await addConnection({ syncVersion: SYNC_VERSION - 1, fullSyncContinueAt: new Date(Date.now() - DAY) });
    await db().syncRun.create({
      data: { connectionId: "c1", status: "partial", mode: "full", startedAt: new Date(Date.now() - DAY), finishedAt: new Date(Date.now() - DAY), entitiesUpdated: { fullSyncProgress: { startedAt: new Date(Date.now() - DAY).toISOString(), version: SYNC_VERSION - 1, done: ["Jobs"] } } },
    });
    await runSyncForConnection("c1", { deadline: Date.now() - 10_000, windowStart: Date.now() - 60_000 });
    expect((await connection()).fullSyncContinueAt).toEqual(FULL_SYNC_PARTWAY_FIRST_AT);
  });

  it("keeps a partway read partway when a retry fails before reading anything", async () => {
    await addConnection({ syncVersion: SYNC_VERSION - 1, fullSyncContinueAt: FULL_SYNC_PARTWAY_FIRST_AT });
    qbo.fail.add("Customer");
    await expect(runSyncForConnection("c1", { deadline: plentyOfTime() })).rejects.toThrow();
    const c = await connection();
    expect(c.fullSyncContinueAt.getTime()).toBeGreaterThan(Date.now() + HOUR);
    expect(fullSyncPartway(c)).toBe(true);
    expect(c.lastFullSyncAt).not.toBeNull();
  });

  it("but a try that read a step before failing is partway, retried a couple of hours on", async () => {
    await addConnection({ fullSyncContinueAt: FULL_SYNC_OWED_AT });
    qbo.fail.add("Purchase");
    await expect(runSyncForConnection("c1", { deadline: plentyOfTime() })).rejects.toThrow();
    const c = await connection();
    expect(c.fullSyncContinueAt.getTime()).toBeGreaterThan(Date.now() + HOUR);
    expect(fullSyncPartway(c)).toBe(true);
  });
});

describe("2. a company the nightly job skips (lapsed, or past its plan's limit)", () => {
  beforeEach(() => {
    resetDb();
    qbo.cdc = {};
    qbo.counts = {};
  });
  const WAIT = 20 * HOUR;

  it("stays owed, not partway, and leaves the line of reads to carry on", async () => {
    await addConnection({ fullSyncContinueAt: FULL_SYNC_OWED_AT });
    await holdFullSyncForSkippedCompany(await connection(), WAIT);
    const c = await connection();
    expect(c.fullSyncContinueAt).toBeNull();
    // Owed as an ordinary full sync: the next sync after the owner pays reads everything.
    expect(c.lastFullSyncAt).toBeNull();
    expect([fullSyncDue(c), fullSyncPartway(c)]).toEqual([true, false]);
    expect(syncProblemFor(c, { paused: false, role: "owner" })).toBeNull();
  });

  it("puts a partway read off a day, still partway", async () => {
    await addConnection({ fullSyncContinueAt: new Date(Date.now() - HOUR) });
    await holdFullSyncForSkippedCompany(await connection(), WAIT);
    const c = await connection();
    expect(c.fullSyncContinueAt.getTime()).toBeGreaterThan(Date.now() + 19 * HOUR);
    expect(fullSyncPartway(c)).toBe(true);
  });

  it("leaves a company with no full read owed alone, and is what the nightly job's skip uses", async () => {
    await addConnection();
    const before = await connection();
    await holdFullSyncForSkippedCompany(before, WAIT);
    const after = await connection();
    expect([after.fullSyncContinueAt, after.lastFullSyncAt]).toEqual([null, before.lastFullSyncAt]);
    const route = readFileSync(join(__dirname, "..", "..", "app", "api", "cron", "nightly-sync", "route.ts"), "utf8");
    expect(route).toContain("await holdFullSyncForSkippedCompany(connection, SKIPPED_FULL_SYNC_WAIT_MS);");
    expect(route).not.toContain("fullSyncContinueAt: new Date(Date.now() + SKIPPED_FULL_SYNC_WAIT_MS)");
  });
});

describe("2. Sync now's pause and a full read partway", () => {
  const NOW = new Date("2026-10-19T12:00:00Z");
  const ago = (s: number) => new Date(NOW.getTime() - s * 1000);
  const justStopped = { lastSyncAttemptAt: ago(5), lastSyncStatus: "success", lastSyncStartedAt: ago(200), lastSyncError: null };

  it("lets the next press carry on with a read that stopped partway", () => {
    expect(syncCooldownSecondsLeft({ ...justStopped, fullSyncContinueAt: ago(5) }, NOW)).toBe(0);
    // Put off partway through, first in line for the next run: the same.
    expect(syncCooldownSecondsLeft({ ...justStopped, fullSyncContinueAt: FULL_SYNC_PARTWAY_FIRST_AT }, NOW)).toBe(0);
  });

  it("pauses as before when nothing is partway, or the read waits for later", () => {
    expect(syncCooldownSecondsLeft({ ...justStopped, fullSyncContinueAt: null }, NOW)).toBe(SYNC_COOLDOWN_SECONDS - 5);
    // Owed, nothing read yet: nothing to carry on with.
    expect(syncCooldownSecondsLeft({ ...justStopped, fullSyncContinueAt: FULL_SYNC_OWED_AT }, NOW)).toBe(SYNC_COOLDOWN_SECONDS - 5);
    // A failed part is retried a couple of hours later.
    expect(syncCooldownSecondsLeft({ ...justStopped, fullSyncContinueAt: new Date(NOW.getTime() + 2 * HOUR) }, NOW)).toBe(SYNC_COOLDOWN_SECONDS - 5);
    // Down to once a day, even once its day comes round.
    expect(syncCooldownSecondsLeft({ ...justStopped, lastSyncError: FULL_SYNC_TOO_LONG_MESSAGE, fullSyncContinueAt: ago(5) }, NOW)).toBe(SYNC_COOLDOWN_SECONDS - 5);
  });

  it("says a read is partway only while one is owed and not down to once a day", () => {
    expect(fullSyncPartway({ fullSyncContinueAt: null, lastSyncError: null })).toBe(false);
    expect(fullSyncPartway({ fullSyncContinueAt: NOW, lastSyncError: null })).toBe(true);
    expect(fullSyncPartway({ fullSyncContinueAt: NOW, lastSyncError: FULL_SYNC_TOO_LONG_MESSAGE })).toBe(false);
    expect(fullSyncPartway({})).toBe(false);
    expect(fullSyncPartway({ fullSyncContinueAt: FULL_SYNC_OWED_AT, lastSyncError: null })).toBe(false);
    expect(fullSyncPartway({ fullSyncContinueAt: FULL_SYNC_PARTWAY_FIRST_AT, lastSyncError: null })).toBe(true);
  });
});

describe("2. the first-run screen's sync loop", () => {
  const unfinished = (remaining: string[], extra: Record<string, unknown> = {}) => ({ ok: true, data: { ok: true, unfinished: true, remaining, steps: 12, jobs: 4, ...extra } });

  it("stops at its cap and leaves the rest to the nightly sync", async () => {
    let calls = 0;
    const outcome = await runFirstSync(async () => {
      calls++;
      return unfinished(FULL_SYNC_STEPS.slice(2));
    });
    expect(FIRST_RUN_MAX_SYNC_CALLS).toBe(8);
    expect(calls).toBe(FIRST_RUN_MAX_SYNC_CALLS);
    expect(outcome).toEqual({ kind: "unfinished", jobs: 4, switched: false });
  });

  it("doesn't take a job count from a run that hasn't read the jobs", async () => {
    const outcome = await runFirstSync(async () => ({ ok: true, data: { ok: true, unfinished: true, deferred: true, remaining: FULL_SYNC_STEPS, steps: 12 } }), () => {}, { maxCalls: 2 });
    expect(outcome).toEqual({ kind: "unfinished", jobs: null, switched: false });
  });

  it("waits out a pause, and a sync already running after the first call, within the cap", async () => {
    const replies = [
      unfinished(FULL_SYNC_STEPS.slice(1)),
      { ok: false, data: { code: "sync_cooldown", retryAfterSeconds: 12, error: "wait" } },
      { ok: false, data: { code: "sync_in_progress", error: "running" } },
      { ok: true, data: { ok: true, jobs: 4 } },
    ];
    const waits: number[] = [];
    const outcome = await runFirstSync(async () => replies.shift()!, () => {}, { wait: async (ms) => void waits.push(ms) });
    expect(waits).toEqual([12_000, 30_000]);
    expect(outcome).toEqual({ kind: "finished", jobs: 4, switched: false });
  });

  it("waits out a sync already running on the first call too: the screen opened again while the read goes on", async () => {
    const replies = [{ ok: false, data: { code: "sync_in_progress", error: "A QuickBooks sync is already running." } }, unfinished(FULL_SYNC_STEPS.slice(5)), { ok: true, data: { ok: true, jobs: 4 } }];
    const waits: number[] = [];
    const progress: number[] = [];
    const outcome = await runFirstSync(async () => replies.shift()!, (p) => progress.push(p.step), { wait: async (ms) => void waits.push(ms) });
    expect(waits).toEqual([30_000]);
    expect(progress).toEqual([6]);
    expect(outcome).toEqual({ kind: "finished", jobs: 4, switched: false });
  });

  it("stops when the screen goes away, without calling again or reporting a failure", async () => {
    const controller = new AbortController();
    let calls = 0;
    const outcome = await runFirstSync(
      async (signal) => {
        calls++;
        controller.abort();
        // An aborted fetch throws.
        if (signal?.aborted) throw Object.assign(new Error("The operation was aborted."), { name: "AbortError" });
        return unfinished(FULL_SYNC_STEPS.slice(2));
      },
      () => {},
      { signal: controller.signal }
    );
    expect(outcome).toEqual({ kind: "cancelled", switched: false });
    expect(calls).toBe(1);
    // A wait in progress ends at once too.
    const waiting = new AbortController();
    const started = Date.now();
    const pending = runFirstSync(async () => ({ ok: false, data: { code: "sync_in_progress" } }), () => {}, { signal: waiting.signal });
    setTimeout(() => waiting.abort(), 5);
    expect(await pending).toEqual({ kind: "cancelled", switched: false });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("shows any other failure as before", async () => {
    expect(await runFirstSync(async () => ({ ok: false, data: null }))).toEqual({
      kind: "failed",
      message: "We couldn't read your QuickBooks data this time.",
      switched: false,
    });
  });
});

// ---------------------------------------------------------------------------
// 3. A paged read that comes back short
// ---------------------------------------------------------------------------

describe("3. a full sync removes nothing a short read didn't return", () => {
  const warnings: string[] = [];
  const realWarn = console.warn;

  beforeEach(async () => {
    resetDb();
    qbo.cdc = {};
    qbo.counts = {};
    warnings.length = 0;
    qbo.data = {
      Account: accounts,
      Customer: [{ Id: "21", DisplayName: "Smith", Active: true }],
      // Line 2 was taken off this purchase in QuickBooks.
      Purchase: [{ Id: "145", TxnDate: dayStr(20), Line: [costLine("1", 300, "21")] }],
      Estimate: [],
    };
    await addConnection({ jobSource: "customers" });
    await db().job.create({ data: { id: "job21", connectionId: "c1", qboId: "21", parentQboId: null, customerName: null, name: "Smith", status: "open", qboCreatedAt: null, missingSince: null } });
    const cost = { jobId: "job21", qboSourceType: "Purchase", category: "materials", accountName: null, description: null, amount: 75, txnDate: new Date(`${dayStr(20)}T00:00:00Z`), attributionMethod: "direct", quantity: null };
    await db().costEntry.create({ data: { ...cost, id: "c1:Purchase:145:2", qboSourceId: "145" } });
    // A purchase the read didn't return: deleted in QuickBooks, or on a page that shifted.
    await db().costEntry.create({ data: { ...cost, id: "c1:Purchase:999:1", qboSourceId: "999" } });
    const untagged = { connectionId: "c1", qboSourceType: "Purchase", kind: "expense", txnDate: new Date(`${dayStr(20)}T00:00:00Z`), docNumber: null, payee: null, accountName: "Job Materials", memo: null, amount: 40 };
    await db().untaggedCost.create({ data: { ...untagged, qboSourceId: "999", lineKey: "1" } });
    await db().untaggedCost.create({ data: { ...untagged, qboSourceId: "145", lineKey: "3" } });
    await db().jobEstimate.create({
      data: { id: "c1:777", connectionId: "c1", qboEstimateId: "777", customerQboId: "21", amount: 9_000, status: "Accepted", txnDate: new Date(`${dayStr(40)}T00:00:00Z`), docNumber: null, customerName: null, emailStatus: null, expirationDate: null, lines: [] },
    });
    console.warn = (...args: unknown[]) => void warnings.push(args.map(String).join(" "));
  });

  const restore = () => {
    console.warn = realWarn;
  };

  it("keeps stored rows of transactions missing from a read shorter than QuickBooks' count", async () => {
    qbo.counts = { Purchase: 5, Estimate: 3 };
    try {
      await runSyncForConnection("c1", { forceFull: true });
    } finally {
      restore();
    }
    const ids = (db().costEntry.rows as any[]).map((r) => r.id).sort();
    // The purchase it did read is brought in step; the one it didn't is kept.
    expect(ids).toEqual(["c1:Purchase:145:1", "c1:Purchase:999:1"]);
    expect((db().untaggedCost.rows as any[]).map((r) => `${r.qboSourceId}:${r.lineKey}`)).toEqual(["999:1"]);
    expect((db().jobEstimate.rows as any[]).map((e) => e.id)).toEqual(["c1:777"]);
    // The type's name only: nothing about the company's data.
    expect(warnings).toEqual([
      "quickbooks sync: Purchase read came back short, so stored rows it didn't return were kept",
      "quickbooks sync: Estimate read came back short, so stored rows it didn't return were kept",
    ]);
  });

  it("removes them once the read matches QuickBooks' count", async () => {
    try {
      await runSyncForConnection("c1", { forceFull: true });
    } finally {
      restore();
    }
    expect((db().costEntry.rows as any[]).map((r) => r.id)).toEqual(["c1:Purchase:145:1"]);
    expect(db().untaggedCost.rows).toEqual([]);
    expect(db().jobEstimate.rows).toEqual([]);
    expect(warnings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 4. Revenue on no job is counted
// ---------------------------------------------------------------------------

describe("4. revenue on no job is counted for Data Health, like costs", () => {
  beforeEach(() => {
    resetDb();
    qbo.cdc = {};
    qbo.counts = {};
  });

  it("counts sales tagged to a customer with two projects", async () => {
    qbo.data = {
      Account: accounts,
      Customer: [
        { Id: "30", DisplayName: "Harborview Properties", Active: true },
        { Id: "31", DisplayName: "Unit 3", Job: true, ParentRef: { value: "30" }, Active: true },
        { Id: "32", DisplayName: "Unit 5", Job: true, ParentRef: { value: "30" }, Active: true },
      ],
      Invoice: [
        { Id: "1", TxnDate: dayStr(20), TotalAmt: 4_000, Balance: 4_000, CustomerRef: { value: "30" } },
        // Past the 12 months the page counts.
        { Id: "2", TxnDate: dayStr(500), TotalAmt: 9_000, Balance: 0, CustomerRef: { value: "30" } },
        { Id: "3", TxnDate: dayStr(20), TotalAmt: 2_000, Balance: 0, CustomerRef: { value: "31" } },
      ],
      Deposit: [
        { Id: "7", TxnDate: dayStr(10), Line: [{ Id: "1", Amount: 600, DepositLineDetail: { AccountRef: { value: "40" }, Entity: { value: "30", type: "Customer" } } }] },
      ],
    };
    await addConnection();
    const r = await runSyncForConnection("c1", { forceFull: true });
    expect([r.unresolvedRevenueCount, r.unresolvedRevenueAmount]).toEqual([2, 4_600]);
    expect([r.unclassedRevenueCount, r.unclassedRevenueAmount]).toEqual([0, 0]);
    // What the Data Health page reads: the last finished full sync.
    expect(await loadUnmatchedRevenue("c1")).toEqual({ unresolvedCount: 2, unresolvedAmount: 4_600, unclassedCount: 0, unclassedAmount: 0 });
  });

  it("counts sales with no class, and on a parent class, when jobs are classes; a credit line's class owes nothing", async () => {
    const sale = (amount: number, classId?: string) => ({ Amount: amount, DetailType: "SalesItemLineDetail", SalesItemLineDetail: classId ? { ClassRef: { value: classId } } : {} });
    qbo.data = {
      Account: accounts,
      Class: [
        { Id: "C1", Name: "Job A", Active: true },
        { Id: "C2", Name: "Job B", Active: true },
        { Id: "P", Name: "Harborview", Active: true },
        { Id: "P1", Name: "Unit 3", ParentRef: { value: "P" }, Active: true },
        { Id: "P2", Name: "Unit 5", ParentRef: { value: "P" }, Active: true },
      ],
      Invoice: [
        { Id: "a", TxnDate: dayStr(15), TotalAmt: 1_000, Balance: 1_000, CustomerRef: { value: "9" }, Line: [sale(3_000, "C1"), sale(-2_000, "C2")] },
        { Id: "b", TxnDate: dayStr(15), TotalAmt: 2_500, Balance: 0, CustomerRef: { value: "9" }, Line: [sale(2_500, "P")] },
        { Id: "c", TxnDate: dayStr(15), TotalAmt: 700, Balance: 0, CustomerRef: { value: "9" }, Line: [sale(700)] },
      ],
      Deposit: [
        {
          Id: "d",
          TxnDate: dayStr(5),
          Line: [
            { Id: "1", Amount: 400, DepositLineDetail: { AccountRef: { value: "40" }, ClassRef: { value: "P" } } },
            // Income with no class: a sale on no job, like an invoice line with none.
            { Id: "2", Amount: 150, DepositLineDetail: { AccountRef: { value: "40" } } },
          ],
        },
      ],
      JournalEntry: [
        {
          Id: "j",
          TxnDate: dayStr(5),
          Line: [
            { Id: "0", Amount: 250, JournalEntryLineDetail: { PostingType: "Credit", AccountRef: { value: "40" } } },
            { Id: "1", Amount: 250, JournalEntryLineDetail: { PostingType: "Debit", AccountRef: { value: "35" } } },
          ],
        },
      ],
      // A refund check to a customer, posted to income with no class.
      Purchase: [{ Id: "k", TxnDate: dayStr(5), AccountRef: { value: "35" }, Line: [{ Id: "1", Amount: 100, AccountBasedExpenseLineDetail: { AccountRef: { value: "40" } } }] }],
    };
    await addConnection({ jobSource: "classes" });
    const r = await runSyncForConnection("c1", { forceFull: true });
    expect([r.unresolvedRevenueCount, r.unresolvedRevenueAmount]).toEqual([2, 2_900]);
    // The invoice line, the deposit line, the journal entry line and the check.
    expect([r.unclassedRevenueCount, r.unclassedRevenueAmount]).toEqual([4, 1_000]);
    // None of them is stored on a job (the deposit's other line is on the parent class).
    expect((db().invoiceSummary.rows as any[]).filter((i) => ["d", "j", "k"].includes(i.qboInvoiceId))).toEqual([]);
    // Item 6 through the sync: the $1,000 still owed is Job A's.
    const owed = (classId: string) => (db().invoiceSummary.rows as any[]).find((i) => i.jobId === jobByQboId(`class:${classId}`).id);
    expect([owed("C1").amount, owed("C1").openBalance]).toEqual([3_000, 1_000]);
    // The credit's class owes nothing, and says so: 0, not "not known".
    expect([owed("C2").amount, owed("C2").openBalance]).toEqual([-2_000, 0]);
  });

  it("reads the counts as not measured until a full sync has counted them", () => {
    expect(unmatchedRevenueFrom(null)).toEqual({ unresolvedCount: null, unresolvedAmount: null, unclassedCount: null, unclassedAmount: null });
    expect(unmatchedRevenueFrom({ unresolvedRevenueCount: 3, unresolvedRevenueAmount: 1_250.5 })).toEqual({
      unresolvedCount: 3,
      unresolvedAmount: 1_250.5,
      unclassedCount: null,
      unclassedAmount: null,
    });
  });

  it("is shown on Data Health beside the unresolved costs", () => {
    const page = readFileSync(join(__dirname, "..", "..", "app", "dashboard", "data-health", "page.tsx"), "utf8");
    expect(page).toContain("loadUnmatchedRevenue(connection.id)");
    expect(page).toContain('"Sales tagged to an unrecognized customer"');
    expect(page).toContain("Sales with no class (last 12 months)");
    expect(page).not.toMatch(/[\u2013\u2014]/);
  });
});

// ---------------------------------------------------------------------------
// 5. Other currencies
// ---------------------------------------------------------------------------

describe("5. amounts in another currency are counted in home currency", () => {
  const lookups = emptyLookups();
  for (const a of accounts) lookups.accounts.set(a.Id, { name: a.Name, fullName: a.Name, type: a.AccountType, subType: a.AccountSubType });
  const cad = { CurrencyRef: { value: "CAD", name: "Canadian Dollar" }, ExchangeRate: 0.73 };

  it("reads the rate, and 1 without one", () => {
    expect(exchangeRate(cad)).toBe(0.73);
    expect(exchangeRate({})).toBe(1);
    expect(exchangeRate({ ExchangeRate: 0 })).toBe(1);
    expect(exchangeRate({ ExchangeRate: "1.36" })).toBe(1.36);
  });

  it("converts bills, vendor credits, purchases and journal entries", () => {
    expect(expenseLines({ Id: "b", ...cad, Line: [costLine("1", 10_000, "21")] }, "Bill", lookups).map((l) => l.amount)).toEqual([7_300]);
    expect(expenseLines({ Id: "v", ...cad, Line: [costLine("1", 500, "21")] }, "VendorCredit", lookups).map((l) => l.amount)).toEqual([-365]);
    expect(expenseLines({ Id: "p", ...cad, Line: [costLine("1", 200, "21")] }, "Purchase", lookups).map((l) => l.amount)).toEqual([146]);
    const je = {
      Id: "j",
      ...cad,
      Line: [
        { Id: "0", Amount: 1_000, JournalEntryLineDetail: { PostingType: "Debit", AccountRef: { value: "80" }, Entity: { Type: "Customer", EntityRef: { value: "21" } } } },
        { Id: "1", Amount: 1_000, JournalEntryLineDetail: { PostingType: "Credit", AccountRef: { value: "40" }, Entity: { Type: "Customer", EntityRef: { value: "21" } } } },
      ],
    };
    expect(expenseLines(je, "JournalEntry", lookups).map((l) => l.amount)).toEqual([730]);
    expect(journalRevenueLines(je, lookups).map((l) => l.amount)).toEqual([730]);
    const refundCheck = { Id: "r", ...cad, Line: [{ Id: "1", Amount: 100, AccountBasedExpenseLineDetail: { AccountRef: { value: "40" }, CustomerRef: { value: "21" } } }] };
    expect(expenseRevenueLines(refundCheck, "Purchase", lookups).map((l) => l.amount)).toEqual([-73]);
  });

  it("converts invoices, sales receipts, credit memos and refund receipts, tax and balance included", () => {
    const inv = revenueFromTxn({ ...cad, TotalAmt: 20_000, TxnTaxDetail: { TotalTax: 1_000 }, Balance: 20_000, TxnDate: "2026-10-01", CustomerRef: { value: "21" } }, "Invoice");
    expect([inv.amount, inv.tax, inv.openBalance, inv.status]).toEqual([13_870, 730, 14_600, "open"]);
    expect(revenueFromTxn({ ...cad, TotalAmt: 1_000 }, "SalesReceipt").amount).toBe(730);
    expect(revenueFromTxn({ ...cad, TotalAmt: 1_000 }, "CreditMemo").amount).toBe(-730);
    expect(revenueFromTxn({ ...cad, TotalAmt: 1_000 }, "RefundReceipt").amount).toBe(-730);
  });

  it("converts deposits, estimates, and leaves time entry cost rates alone", () => {
    const deposit = {
      Id: "d",
      ...cad,
      Line: [
        { Id: "1", Amount: 1_000, DepositLineDetail: { AccountRef: { value: "40" }, Entity: { value: "21", type: "Customer" } } },
        { Id: "2", Amount: 300, DepositLineDetail: { AccountRef: { value: "80" }, Entity: { value: "21", type: "Customer" } } },
      ],
    };
    expect(depositRevenueLines(deposit, lookups).map((l) => l.amount)).toEqual([730]);
    expect(depositCostLines(deposit, lookups).map((l) => l.amount)).toEqual([-219]);
    expect(estimateFromTxn({ ...cad, TotalAmt: 10_000, TxnStatus: "Accepted", TxnDate: "2026-10-01" }).record!.amount).toBe(7_300);
    const time = timeActivityCost({ ...cad, CustomerRef: { value: "21" }, EmployeeRef: { value: "e1" }, Hours: 2, CostRate: 40 });
    expect(time).toMatchObject({ kind: "cost", amount: 80 });
  });

  it("stores a CAD bill and invoice in home currency through the sync", async () => {
    resetDb();
    qbo.cdc = {};
    qbo.counts = {};
    qbo.data = {
      Account: accounts,
      Customer: [{ Id: "21", DisplayName: "Smith", Active: true }],
      Bill: [{ Id: "b1", TxnDate: dayStr(5), ...cad, Line: [costLine("1", 10_000, "21")] }],
      Invoice: [{ Id: "i1", TxnDate: dayStr(5), ...cad, TotalAmt: 20_000, Balance: 20_000, CustomerRef: { value: "21" } }],
    };
    await addConnection({ jobSource: "customers" });
    await runSyncForConnection("c1", { forceFull: true });
    const job = jobByQboId("21");
    expect(costsOn(job.id).map((c) => Number(c.amount))).toEqual([7_300]);
    expect(revenueOn(job.id).map((i) => [Number(i.amount), Number(i.openBalance)])).toEqual([[14_600, 14_600]]);
  });
});

// ---------------------------------------------------------------------------
// 6. Class mode: an invoice's balance
// ---------------------------------------------------------------------------

describe("6. in class mode an invoice's balance is owed by the classes billed on it", () => {
  const sale = (amount: number, classId: string) => ({ Amount: amount, DetailType: "SalesItemLineDetail", SalesItemLineDetail: { ClassRef: { value: classId } } });

  it("puts nothing owed on a class with only a credit, and never more than the balance in all", () => {
    const parts = revenueByClass({ TotalAmt: 1_000, Balance: 1_000, Line: [sale(3_000, "A"), sale(-2_000, "B")] }, "Invoice");
    expect(parts.map((p) => [p.classQboId, p.amount, p.openBalance])).toEqual([["A", 3_000, 1_000], ["B", -2_000, 0]]);
  });

  it("shares the balance across the billed classes by their lines, adding up to it exactly", () => {
    const parts = revenueByClass({ TotalAmt: 2_000, Balance: 1_000, Line: [sale(1_000, "A"), sale(1_000, "B"), sale(1_000, "C"), sale(-1_000, "D")] }, "Invoice");
    const owed = parts.map((p) => p.openBalance);
    expect(owed).toEqual([333.33, 333.33, 333.34, 0]);
    expect(owed.reduce((s: number, v) => s + (v ?? 0), 0)).toBeCloseTo(1_000, 6);
    // Paid in full: nothing owed anywhere.
    expect(revenueByClass({ TotalAmt: 1_000, Balance: 0, Line: [sale(3_000, "A"), sale(-2_000, "B")] }, "Invoice").map((p) => p.openBalance)).toEqual([null, null]);
  });
});

// ---------------------------------------------------------------------------
// 7. A project moved to another customer
// ---------------------------------------------------------------------------

describe("7. moving a stored project to another customer asks for a full sync", () => {
  it("names the parents whose costs move", () => {
    const existing = [
      { qboId: "71", parentQboId: "70" },
      { qboId: "81", parentQboId: "80" },
      { qboId: "91", parentQboId: "90" },
      { qboId: "92", parentQboId: "90" },
      { qboId: "93", parentQboId: "90" },
    ];
    // 71 moves from 70 (its only job) to 80 (which had one): both change.
    expect(parentsNeedingFullSync(existing, [{ qboId: "71", parentQboId: "80" }]).sort()).toEqual(["70", "80"]);
    // 93 moves from 90 (three jobs) to 95 (none): only 95 gains an only job.
    expect(parentsNeedingFullSync(existing, [{ qboId: "93", parentQboId: "95" }])).toEqual(["95"]);
    // Re-sent unchanged: nothing.
    expect(parentsNeedingFullSync(existing, [{ qboId: "71", parentQboId: "70" }])).toEqual([]);
    // As before: a parent's first job, and its second.
    expect(parentsNeedingFullSync(existing, [{ qboId: "72", parentQboId: "70" }, { qboId: "55", parentQboId: "50" }]).sort()).toEqual(["50", "70"]);
  });

  async function setUp() {
    resetDb();
    qbo.counts = {};
    qbo.data = { Account: accounts };
    await addConnection();
    await db().job.create({ data: { id: "job71", connectionId: "c1", qboId: "71", parentQboId: "70", customerName: "Old Client", name: "Kitchen", status: "open", qboCreatedAt: null, missingSince: null } });
  }

  it("on the incremental sync that sees the move", async () => {
    await setUp();
    qbo.cdc = { Customer: [{ Id: "71", DisplayName: "Kitchen", Job: true, ParentRef: { value: "80", name: "New Client" }, Active: true, MetaData: created(400) }] };
    const r = await runSyncForConnection("c1");
    expect(r.mode).toBe("incremental");
    expect(r.fullSyncRequested).toBe(true);
    expect((await connection()).lastFullSyncAt).toBeNull();
    expect(jobByQboId("71").parentQboId).toBe("80");
  });

  it("not when the project is only renamed", async () => {
    await setUp();
    qbo.cdc = { Customer: [{ Id: "71", DisplayName: "Kitchen remodel", Job: true, ParentRef: { value: "70", name: "Old Client" }, Active: true, MetaData: created(400) }] };
    const r = await runSyncForConnection("c1");
    expect(r.fullSyncRequested).toBeUndefined();
    expect((await connection()).lastFullSyncAt).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 8. The first-run screen's words
// ---------------------------------------------------------------------------

describe("8. the first-run screen", () => {
  const source = readFileSync(join(__dirname, "..", "..", "components", "dashboard", "FirstRunSetup.tsx"), "utf8");
  const asShown = source.replace(/&apos;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ");

  it("explains where jobs come from when it finds none", () => {
    expect(asShown).toContain(
      "QuickBooks is connected, but we didn't find any customers to read as jobs. JobProfitAI reads each job from a QuickBooks Project or sub-customer, a customer if you make one customer per job, or a Class. Add a customer, or a sub-customer under it, for each job and pick it on that job's invoices, bills and expenses, then click \"Sync now\" above. Projects and Classes need QuickBooks Online Plus or Advanced. Not sure which fits? Email"
    );
    expect(source).toContain('const SUPPORT_ADDRESS = "support@jobprofitai.com"');
    expect(asShown).toContain("Still reading your QuickBooks history, step {phase.step} of {phase.of}.");
    expect(source).not.toMatch(/[\u2013\u2014]/);
  });

  it("is told once when the first sync reads each customer as one job", async () => {
    resetDb();
    qbo.cdc = {};
    qbo.counts = {};
    qbo.data = { Account: accounts, Customer: [{ Id: "21", DisplayName: "Smith", Active: true }, { Id: "22", DisplayName: "Jones", Active: true }] };
    // A new company, its job setup not confirmed: the first sync picks.
    await addConnection({ syncVersion: 1, lastFullSyncAt: null, lastSyncedAt: null, lastSyncAttemptAt: null, lastSyncStatus: null, jobSourceConfirmedAt: null });
    let calls = 0;
    const outcome = await runFirstSync(async () => {
      calls++;
      return { ok: true, data: await runSyncForConnection("c1", { forceFull: true, deadline: calls === 1 ? noTimeLeft() : plentyOfTime(), resumeWithinMs: HOUR }) };
    });
    // Said on the first run's response, and kept through the run that finishes the read.
    expect(outcome).toEqual({ kind: "finished", jobs: 2, switched: true });
    expect((await connection()).jobSource).toBe("customers");
    expect(SWITCHED_TO_CUSTOMERS_NOTICE).toBe(
      "Your QuickBooks has no Projects or sub-customers, so each customer is read as one job. If a customer has several jobs, add a sub-customer for each, or change how jobs are set up in Settings."
    );
    expect(source).toContain("{SWITCHED_TO_CUSTOMERS_NOTICE}");
  });
});
