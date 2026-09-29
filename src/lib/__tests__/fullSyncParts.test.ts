import { describe, it, expect, beforeEach, vi } from "vitest";
import { createFakePrisma, FakeModel, type FakePrisma } from "./support/fakePrisma";

// A full sync with a deadline (the nightly job's) stops between two of its
// steps when its time is nearly up, and the next run carries on with the
// steps it hadn't done. Before, a company whose full sync outlasted the
// function's time limit never finished: it was cut off and retried every
// hour, taking every other company's sync and alert emails in that run down
// with it each time.

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
const qbo: { data: Record<string, any[]>; reads: string[]; fail: Set<string>; cdcFails: boolean } = {
  data: {},
  reads: [],
  fail: new Set(),
  cdcFails: false,
};
vi.mock("@/lib/quickbooks", () => ({
  qboQueryAll: async (_realm: string, _token: string, _query: string, entity: string) => {
    qbo.reads.push(entity);
    if (qbo.fail.has(entity)) throw new Error("QuickBooks returned 500");
    return qbo.data[entity] ?? [];
  },
  qboQuery: async () => ({}),
  qboCompanyInfo: async () => ({}),
  qboCdc: async () => {
    if (qbo.cdcFails) throw new Error("Change Data Capture returned 1000 records, at or over its cap");
    return { CDCResponse: [{ QueryResponse: [] }] };
  },
  refreshTokens: async () => {
    throw new Error("not expected");
  },
  needsReconnect: (message: string | null | undefined) => (message ?? "").startsWith("Your QuickBooks connection has expired"),
}));

import {
  FULL_SYNC_MAX_CUT_OFF,
  FULL_SYNC_MAX_PARTS,
  FULL_SYNC_STEPS,
  FULL_SYNC_TOO_LONG_MESSAGE,
  FullSyncNotAllowedError,
  fullSyncDue,
  fullSyncFirstStepFits,
  fullSyncStepFits,
  fullSyncStuck,
  runSyncForConnection,
  SYNC_VERSION,
  usableFullSyncProgress,
} from "../quickbooksSync";
import { syncProblemFor } from "../syncProblem";
import { customerSyncError } from "../briefSend";

const DAY = 86_400_000;
const HOUR = 3_600_000;
const INTERRUPTED = "Interrupted before it finished (time limit). Retried automatically.";
/** Past already: each run does its one guaranteed step and stops. */
const noTimeLeft = () => Date.now() - 1;
const plentyOfTime = () => Date.now() + HOUR;
const tick = () => new Promise((resolve) => setTimeout(resolve, 3));

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

const lastAttempt = new Date(Date.now() - 2 * DAY);

async function addConnection(extra: Record<string, unknown> = {}) {
  await fake.client.quickBooksConnection.create({
    data: {
      id: "c1",
      userId: "u1",
      realmId: "realm",
      realmIdHash: "h1",
      accessToken: "token",
      refreshToken: "refresh",
      accessTokenExpiresAt: new Date(Date.now() + HOUR),
      companyName: "Acme Builders",
      jobSource: "customers",
      laborFromTimeEntries: false,
      // Waiting for the upgrade to the current rules, as every company was when version 6 shipped.
      syncVersion: SYNC_VERSION - 1,
      lastFullSyncAt: new Date(Date.now() - 10 * DAY),
      lastSyncedAt: lastAttempt,
      lastSyncAttemptAt: lastAttempt,
      lastSyncStatus: "success",
      lastSyncError: null,
      jobSourceConfirmedAt: new Date(Date.now() - 30 * DAY),
      rebuildRequestedAt: null,
      basisChangedAt: null,
      fullSyncContinueAt: null,
      fullSyncCutShortAt: null,
      ...extra,
    },
  });
}

const connection = () => fake.client.quickBooksConnection.findUnique({ where: { id: "c1" } }) as Promise<any>;
const runs = () => (fake.client as any).syncRun.rows as any[];
const costIds = () => ((fake.client as any).costEntry.rows as any[]).map((r) => r.id).sort();

/** A cost row stored by an earlier sync for a transaction QuickBooks no longer has. */
async function storedCost(id: string, type: string) {
  await (fake.client as any).costEntry.create({
    data: {
      id, jobId: "job21", qboSourceType: type, qboSourceId: `gone-${id}`, category: "materials", accountName: null,
      description: null, amount: 75, txnDate: new Date("2026-08-01T00:00:00Z"), attributionMethod: "direct", quantity: null,
    },
  });
}

describe("a full sync over several runs", () => {
  beforeEach(async () => {
    resetDb();
    qbo.reads = [];
    qbo.fail = new Set();
    qbo.cdcFails = false;
    qbo.data = {
      Account: [{ Id: "80", Name: "Job Materials", AccountType: "Cost of Goods Sold", AccountSubType: "SuppliesMaterialsCogs" }],
      Customer: [{ Id: "21", DisplayName: "Smith", Active: true }],
      Purchase: [
        {
          Id: "145",
          TxnDate: "2026-09-10",
          Line: [{ Id: "1", Amount: 300, AccountBasedExpenseLineDetail: { AccountRef: { value: "80", name: "Job Materials" }, CustomerRef: { value: "21", name: "Smith" } } }],
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
    await storedCost("oldPurchase", "Purchase");
    await storedCost("oldBill", "Bill");
  });

  it("stops between steps when time runs short, and carries on where it stopped", async () => {
    const first = await runSyncForConnection("c1", { deadline: noTimeLeft() });
    expect(first.unfinished).toBe(true);
    expect(first.remaining).toEqual(FULL_SYNC_STEPS.slice(1));
    expect(runs().map((r) => r.status)).toEqual(["partial"]);
    const progress = runs()[0].entitiesUpdated.fullSyncProgress;
    expect(progress.done).toEqual(["Jobs"]);
    let c = await connection();
    // Not marked synced or upgraded until every step is done.
    expect(c.syncVersion).toBe(SYNC_VERSION - 1);
    expect(c.lastSyncedAt).toEqual(lastAttempt);
    expect(c.lastSyncStatus).toBe("success");
    expect(c.fullSyncContinueAt).not.toBeNull();
    expect(fullSyncDue(c)).toBe(true);
    expect(costIds()).toEqual(["oldBill", "oldPurchase"]);

    await tick();
    const second = await runSyncForConnection("c1", { deadline: noTimeLeft() });
    expect(second.remaining).toEqual(FULL_SYNC_STEPS.slice(2));
    // The jobs aren't read again; Purchase is read in full, and only then
    // are its stored rows brought in step. Bill's wait for Bill's own read.
    expect(qbo.reads.filter((e) => e === "Customer")).toHaveLength(1);
    expect(costIds()).toContain("oldBill");
    expect(costIds()).not.toContain("oldPurchase");

    await tick();
    const last = await runSyncForConnection("c1", { deadline: plentyOfTime() });
    expect(last.unfinished).toBeUndefined();
    expect(last.jobs).toBe(1);
    expect(last.purchases).toBe(1);
    expect(last.invoices).toBe(1);
    expect(last.fullSyncRuns).toBe(3);
    expect(last.costRowsRemoved).toBe(2);
    expect(costIds()).not.toContain("oldBill");
    expect(runs().map((r) => r.status)).toEqual(["partial", "partial", "success"]);
    c = await connection();
    expect(c.syncVersion).toBe(SYNC_VERSION);
    expect(c.lastFullSyncAt).not.toBeNull();
    expect(c.fullSyncContinueAt).toBeNull();
    // The next incremental sync asks for changes since the first run started.
    expect(c.lastSyncedAt).toEqual(new Date(progress.startedAt));
    expect(fullSyncDue(c)).toBe(false);
  });

  it("keeps the steps a run finished when the platform stops it at the time limit", async () => {
    // Stopped while reading invoices: in the test the read fails, and the
    // run is then made to look like one the platform cut off.
    qbo.fail.add("Invoice");
    await runSyncForConnection("c1", { deadline: plentyOfTime() }).catch(() => null);
    const longAgo = new Date(Date.now() - 20 * 60_000);
    Object.assign(runs()[0], { status: "in_progress", finishedAt: null, errorMessage: null, startedAt: longAgo });
    await fake.client.quickBooksConnection.update({ where: { id: "c1" }, data: { lastSyncStatus: "in_progress", lastSyncAttemptAt: longAgo } });
    qbo.fail.clear();
    qbo.reads = [];

    const r = await runSyncForConnection("c1", { deadline: noTimeLeft() });
    expect(runs()[0].status).toBe("error");
    expect(runs()[0].errorMessage).toBe(INTERRUPTED);
    // Carried on from invoices; nothing before them was read again.
    expect(r.remaining).toEqual(FULL_SYNC_STEPS.slice(FULL_SYNC_STEPS.indexOf("Invoice") + 1));
    expect(qbo.reads.filter((e) => e !== "Account" && e !== "Item")).toEqual(["Invoice"]);
    expect(costIds()).not.toContain("oldBill");
  });

  it("doesn't carry on from a stopped read once a later sync has finished", async () => {
    // Sync now stopped at invoices, leaving progress through time entries.
    qbo.fail.add("Invoice");
    await runSyncForConnection("c1", { forceFull: true, deadline: plentyOfTime(), resumeWithinMs: HOUR }).catch(() => null);
    qbo.fail.clear();
    await tick();
    // Incremental syncs ran for days after it.
    await fake.client.quickBooksConnection.update({ where: { id: "c1" }, data: { lastSyncedAt: new Date(), lastSyncStatus: "success", fullSyncContinueAt: null } });
    await tick();
    const r = await runSyncForConnection("c1", { deadline: noTimeLeft() });
    expect(r.remaining).toEqual(FULL_SYNC_STEPS.slice(1));
    expect(qbo.reads.filter((e) => e === "Customer")).toHaveLength(2);
  });

  it("starts nothing late in a window when the first step wouldn't finish in time, and goes first next time", async () => {
    // The last full sync read the customer list in 200 seconds.
    await (fake.client as any).syncRun.create({
      data: {
        connectionId: "c1", mode: "full", status: "success", startedAt: new Date(Date.now() - 40 * DAY), finishedAt: new Date(Date.now() - 40 * DAY),
        entitiesUpdated: { stepMs: { Lookups: 5_000, Jobs: 200_000 } },
      },
    });
    const late = await runSyncForConnection("c1", { deadline: Date.now() + 60_000, windowStart: Date.now() - 150_000 });
    expect(late.deferred).toBe(true);
    expect(late.remaining).toEqual([...FULL_SYNC_STEPS]);
    // Nothing read, nothing recorded (so not a try), the claim handed back.
    expect(qbo.reads).toEqual([]);
    expect(runs()).toHaveLength(1);
    let c = await connection();
    expect(c.lastSyncStatus).toBe("success");
    expect(c.lastSyncAttemptAt).toEqual(lastAttempt);
    expect(c.fullSyncContinueAt.getTime()).toBe(0);
    expect(fullSyncDue(c)).toBe(true);

    // At the start of the next window it goes ahead, even though the step
    // may run long: no run would have more time.
    const early = await runSyncForConnection("c1", { deadline: Date.now() + 20_000, windowStart: Date.now() });
    expect(early.deferred).toBeUndefined();
    expect(early.remaining).toEqual(FULL_SYNC_STEPS.slice(1));
    c = await connection();
    expect(c.fullSyncContinueAt.getTime()).toBeGreaterThan(Date.now() - 60_000);
  });

  it("does it all in one run when there's time", async () => {
    const r = await runSyncForConnection("c1", { deadline: plentyOfTime() });
    expect(r.unfinished).toBeUndefined();
    expect(r.fullSyncRuns).toBeUndefined();
    expect(Object.keys(r.stepMs).sort()).toEqual([...FULL_SYNC_STEPS, "Lookups"].sort());
    expect(runs().map((x) => x.status)).toEqual(["success"]);
  });

  it("starts again from the jobs when Settings asks for a rebuild after it started", async () => {
    await runSyncForConnection("c1", { deadline: noTimeLeft() });
    await tick();
    await fake.client.quickBooksConnection.update({ where: { id: "c1" }, data: { rebuildRequestedAt: new Date(), lastFullSyncAt: null } });
    await tick();
    const r = await runSyncForConnection("c1", { deadline: noTimeLeft() });
    expect(r.remaining).toEqual(FULL_SYNC_STEPS.slice(1));
    expect(qbo.reads.filter((e) => e === "Customer")).toHaveLength(2);
  });

  it("leaves Sync now reading everything afresh, and the stopped one is then done with", async () => {
    await runSyncForConnection("c1", { deadline: noTimeLeft() });
    await tick();
    // Sync now's pause (syncCooldown.ts) is the route's business, not this module's.
    const r = await runSyncForConnection("c1", { forceFull: true });
    expect(r.unfinished).toBeUndefined();
    expect(qbo.reads.filter((e) => e === "Customer")).toHaveLength(2);
    const c = await connection();
    expect(c.fullSyncContinueAt).toBeNull();
    expect(fullSyncDue(c)).toBe(false);
  });

  it("lets a second Sync now carry on from a recent stopped read, but not an old one", async () => {
    // Sync now has a deadline too, so a large company's second press must
    // pick up where the first stopped rather than reread the same steps.
    const first = await runSyncForConnection("c1", { forceFull: true, deadline: noTimeLeft(), resumeWithinMs: HOUR });
    expect(first.unfinished).toBe(true);
    await tick();
    const second = await runSyncForConnection("c1", { forceFull: true, deadline: noTimeLeft(), resumeWithinMs: HOUR });
    expect(second.remaining).toEqual(FULL_SYNC_STEPS.slice(2));
    expect(qbo.reads.filter((e) => e === "Customer")).toHaveLength(1);
    // The window counts from when the read last moved, not from when it
    // began: a read that began two hours ago but moved a moment ago carries on.
    let progress = runs()[runs().length - 1].entitiesUpdated.fullSyncProgress;
    progress.startedAt = new Date(Date.now() - 2 * HOUR).toISOString();
    await tick();
    const third = await runSyncForConnection("c1", { forceFull: true, deadline: noTimeLeft(), resumeWithinMs: HOUR });
    expect(third.remaining).toEqual(FULL_SYNC_STEPS.slice(3));
    expect(qbo.reads.filter((e) => e === "Customer")).toHaveLength(1);
    // One that last moved more than the window ago is read afresh.
    progress = runs()[runs().length - 1].entitiesUpdated.fullSyncProgress;
    progress.savedAt = new Date(Date.now() - 2 * HOUR).toISOString();
    runs()[runs().length - 1].finishedAt = new Date(Date.now() - 2 * HOUR);
    await tick();
    const fourth = await runSyncForConnection("c1", { forceFull: true, deadline: noTimeLeft(), resumeWithinMs: HOUR });
    expect(fourth.remaining).toEqual(FULL_SYNC_STEPS.slice(1));
    expect(qbo.reads.filter((e) => e === "Customer")).toHaveLength(2);
  });

  it("waits a couple of hours, like any failed sync, when a step fails partway", async () => {
    await runSyncForConnection("c1", { deadline: noTimeLeft() });
    await tick();
    qbo.fail.add("Purchase");
    const failed = await runSyncForConnection("c1", { deadline: noTimeLeft() }).catch((err: Error) => err);
    expect(failed instanceof Error ? failed.message : "").toBe("QuickBooks returned 500");
    const c = await connection();
    expect(c.lastSyncStatus).toBe("error");
    expect(c.fullSyncContinueAt.getTime()).toBeGreaterThan(Date.now() + HOUR);
    expect(c.fullSyncContinueAt.getTime()).toBeLessThan(Date.now() + 3 * HOUR);
    // Still carried on from where it was, not started over.
    qbo.fail.clear();
    await tick();
    const r = await runSyncForConnection("c1", { deadline: noTimeLeft() });
    expect(r.remaining).toEqual(FULL_SYNC_STEPS.slice(2));
  });
});

describe("figures changed by an upgrade to new rules", () => {
  // A row new on a transaction QuickBooks hasn't changed since the last sync
  // comes from the new rules (a supplier refund deposited to a cost account,
  // a refund check stored as revenue), so the brief and alerts mustn't
  // report it as a change on the job (basisChangedAt).
  const purchase = (lastUpdated: Date) => ({
    Id: "145",
    TxnDate: "2026-09-10",
    MetaData: { CreateTime: "2026-09-10T10:00:00-07:00", LastUpdatedTime: lastUpdated.toISOString() },
    Line: [{ Id: "1", Amount: 300, AccountBasedExpenseLineDetail: { AccountRef: { value: "80", name: "Job Materials" }, CustomerRef: { value: "21", name: "Smith" } } }],
  });

  beforeEach(async () => {
    resetDb();
    qbo.reads = [];
    qbo.fail = new Set();
    await addConnection();
    await fake.client.job.create({
      data: {
        id: "job21", connectionId: "c1", qboId: "21", parentQboId: null, customerName: null, name: "Smith", status: "open",
        qboCreatedAt: null, missingSince: null, estimatedCost: null, manualContractValue: null, percentCompleteOverride: null,
        category: null, statusOverride: null, estimatedRevenue: null,
      },
    });
  });

  const withPurchase = (lastUpdated: Date) => {
    qbo.data = {
      Account: [{ Id: "80", Name: "Job Materials", AccountType: "Cost of Goods Sold", AccountSubType: "SuppliesMaterialsCogs" }],
      Customer: [{ Id: "21", DisplayName: "Smith", Active: true }],
      Purchase: [purchase(lastUpdated)],
    };
  };

  it("counts rows new on a transaction unchanged since the last sync", async () => {
    withPurchase(new Date(Date.now() - 10 * DAY));
    const r = await runSyncForConnection("c1", { deadline: plentyOfTime() });
    expect(r.figureRowsChanged).toBe(1);
    expect((await connection()).basisChangedAt).not.toBeNull();
  });

  it("doesn't count rows on a transaction entered or changed since the last sync", async () => {
    withPurchase(new Date(Date.now() - HOUR));
    const r = await runSyncForConnection("c1", { deadline: plentyOfTime() });
    expect(r.figureRowsChanged).toBe(0);
    expect((await connection()).basisChangedAt).toBeNull();
  });
});

describe("a full sync that can't finish", () => {
  beforeEach(async () => {
    resetDb();
    qbo.reads = [];
    qbo.fail = new Set();
    qbo.data = { Customer: [{ Id: "21", DisplayName: "Smith", Active: true }] };
    await addConnection();
  });

  const pastRuns = async (n: number, status: string, errorMessage: string | null = null) => {
    for (let i = 0; i < n; i++) {
      await (fake.client as any).syncRun.create({
        data: { connectionId: "c1", mode: "full", status, errorMessage, startedAt: new Date(Date.now() - (n - i) * HOUR), finishedAt: new Date() },
      });
    }
  };

  it(`is flagged with a plain error and tried once a day after ${FULL_SYNC_MAX_PARTS} runs`, async () => {
    await pastRuns(FULL_SYNC_MAX_PARTS - 1, "partial");
    await runSyncForConnection("c1", { deadline: noTimeLeft() });
    const c = await connection();
    expect(c.lastSyncStatus).toBe("error");
    expect(c.lastSyncError).toBe(FULL_SYNC_TOO_LONG_MESSAGE);
    expect(c.fullSyncContinueAt.getTime()).toBeGreaterThan(Date.now() + 23 * HOUR);
    // The dashboard strip flags it, and the brief-on-hold email may quote it.
    const problem = syncProblemFor(c, { paused: false, role: "owner" });
    expect(problem?.tone).toBe("warning");
    // Its own wording: Sync now wouldn't help, so the strip doesn't suggest it.
    expect(problem?.message).toMatch(/keeps running out of time/);
    expect(problem?.message).not.toMatch(/Sync now/);
    expect(customerSyncError(c.lastSyncError)).toBe(FULL_SYNC_TOO_LONG_MESSAGE);
    expect(FULL_SYNC_TOO_LONG_MESSAGE).not.toMatch(/[\u2013\u2014]/);
  });

  it("is put a day out before it runs once cut off at the time limit too often", async () => {
    await pastRuns(FULL_SYNC_MAX_CUT_OFF, "error", INTERRUPTED);
    // Seen from inside the run: even if this run is cut off too, the next
    // try is tomorrow, not in 15 minutes.
    const seen: any[] = [];
    const original = (fake.client as any).syncRun.create.bind((fake.client as any).syncRun);
    (fake.client as any).syncRun.create = async (args: any) => {
      seen.push(await connection());
      return original(args);
    };
    await runSyncForConnection("c1", { deadline: noTimeLeft() });
    expect(seen[0].fullSyncContinueAt.getTime()).toBeGreaterThan(Date.now() + 23 * HOUR);
    expect(seen[0].lastSyncError).toBe(FULL_SYNC_TOO_LONG_MESSAGE);
    // It still carries on (and would clear the flag by finishing).
    expect((await connection()).lastSyncStatus).toBe("error");
  });

  it("counts again from a rebuild Settings asked for", async () => {
    await pastRuns(FULL_SYNC_MAX_PARTS - 1, "partial");
    await fake.client.quickBooksConnection.update({ where: { id: "c1" }, data: { rebuildRequestedAt: new Date(Date.now() - 1_000), lastFullSyncAt: null } });
    await runSyncForConnection("c1", { deadline: noTimeLeft() });
    const c = await connection();
    expect(c.lastSyncStatus).toBe("success");
    expect(c.lastSyncError).toBeNull();
  });
});

describe("the nightly job's other workers leave full syncs to its one slot", () => {
  beforeEach(async () => {
    resetDb();
    qbo.reads = [];
    qbo.fail = new Set();
    qbo.cdcFails = false;
    qbo.data = {};
  });

  it("hands the claim back untouched when a full sync is due", async () => {
    await addConnection();
    await expect(runSyncForConnection("c1", { deferFullSync: true })).rejects.toBeInstanceOf(FullSyncNotAllowedError);
    expect(qbo.reads).toEqual([]);
    expect(runs()).toHaveLength(0);
    const c = await connection();
    expect(c.lastSyncStatus).toBe("success");
    expect(c.lastSyncAttemptAt).toEqual(lastAttempt);
  });

  it("owes the next run a full sync when the change feed fails, without showing an error", async () => {
    await addConnection({ syncVersion: SYNC_VERSION, lastFullSyncAt: new Date(Date.now() - 3 * DAY) });
    qbo.cdcFails = true;
    await expect(runSyncForConnection("c1", { deferFullSync: true })).rejects.toBeInstanceOf(FullSyncNotAllowedError);
    // No full read here: the chart of accounts is the first thing one reads.
    expect(qbo.reads).toEqual([]);
    const c = await connection();
    expect(c.lastSyncStatus).toBe("success");
    expect(c.lastSyncAttemptAt).toEqual(lastAttempt);
    expect(c.fullSyncContinueAt).not.toBeNull();
    expect(fullSyncDue(c)).toBe(true);
  });
});

describe("full sync rules", () => {
  const now = Date.parse("2026-09-28T12:00:00Z");

  it("says when a full sync is due", () => {
    const current = { syncVersion: SYNC_VERSION, lastFullSyncAt: new Date(now - 3 * DAY), fullSyncContinueAt: null };
    expect(fullSyncDue(current, now)).toBe(false);
    expect(fullSyncDue({ ...current, fullSyncContinueAt: new Date(now) }, now)).toBe(true);
    expect(fullSyncDue({ ...current, syncVersion: SYNC_VERSION - 1 }, now)).toBe(true);
    expect(fullSyncDue({ ...current, lastFullSyncAt: null }, now)).toBe(true);
    expect(fullSyncDue({ ...current, lastFullSyncAt: new Date(now - 31 * DAY) }, now)).toBe(true);
  });

  it("starts a step only if it's expected to finish in time", () => {
    expect(fullSyncStepFits("Purchase", undefined, {}, now)).toBe(true);
    // Never timed: allowed 30 seconds.
    expect(fullSyncStepFits("Purchase", now + 31_000, {}, now)).toBe(true);
    expect(fullSyncStepFits("Purchase", now + 29_000, {}, now)).toBe(false);
    // Timed at 100 seconds last month: allowed half as long again.
    expect(fullSyncStepFits("Purchase", now + 140_000, { Purchase: 100_000 }, now)).toBe(false);
    expect(fullSyncStepFits("Purchase", now + 160_000, { Purchase: 100_000 }, now)).toBe(true);
    expect(fullSyncStepFits("Bill", now + 6_000, { Bill: 200 }, now)).toBe(true);
  });

  it("counts runs cut off at the time limit sooner than runs that stopped in time", () => {
    const partial = { status: "partial", errorMessage: null };
    const cutOff = { status: "error", errorMessage: INTERRUPTED };
    const failed = { status: "error", errorMessage: "QuickBooks returned 500" };
    expect(fullSyncStuck(Array(FULL_SYNC_MAX_PARTS - 1).fill(partial))).toBe(false);
    expect(fullSyncStuck(Array(FULL_SYNC_MAX_PARTS).fill(partial))).toBe(true);
    expect(fullSyncStuck(Array(FULL_SYNC_MAX_CUT_OFF - 1).fill(cutOff))).toBe(false);
    expect(fullSyncStuck(Array(FULL_SYNC_MAX_CUT_OFF).fill(cutOff))).toBe(true);
    // Other failures have their own message and retry, and don't count.
    expect(fullSyncStuck(Array(20).fill(failed))).toBe(false);
  });

  it("carries on only from progress made under the same rules and setup", () => {
    const c = { jobSource: "customers", laborFromTimeEntries: false, rebuildRequestedAt: null, lastSyncedAt: new Date(now - 2 * DAY) };
    const progress = {
      startedAt: new Date(now - HOUR).toISOString(),
      version: SYNC_VERSION,
      jobSource: "customers",
      laborFromTimeEntries: false,
      done: ["Jobs"],
      parts: 1,
      jobs: 1,
      fetched: {},
      tallies: {},
      totals: {},
      errors: {},
      stepMs: {},
    };
    expect(usableFullSyncProgress(progress, c, now)).not.toBeNull();
    expect(usableFullSyncProgress(null, c, now)).toBeNull();
    expect(usableFullSyncProgress({ ...progress, version: SYNC_VERSION - 1 }, c, now)).toBeNull();
    expect(usableFullSyncProgress(progress, { ...c, jobSource: "classes" }, now)).toBeNull();
    expect(usableFullSyncProgress(progress, { ...c, laborFromTimeEntries: true }, now)).toBeNull();
    expect(usableFullSyncProgress(progress, { ...c, rebuildRequestedAt: new Date(now - 60_000) }, now)).toBeNull();
    expect(usableFullSyncProgress(progress, { ...c, rebuildRequestedAt: new Date(now - 2 * HOUR) }, now)).not.toBeNull();
    expect(usableFullSyncProgress({ ...progress, startedAt: new Date(now - 21 * DAY).toISOString() }, c, now)).toBeNull();
    // A sync finished since the read began (an incremental one, or this read's own last run).
    expect(usableFullSyncProgress(progress, { ...c, lastSyncedAt: new Date(now - 30_000) }, now)).toBeNull();
    expect(usableFullSyncProgress(progress, { ...c, lastSyncedAt: new Date(progress.startedAt) }, now)).toBeNull();
    expect(usableFullSyncProgress(progress, { ...c, lastSyncedAt: null }, now)).not.toBeNull();
  });

  it("lets a run's first step run past the deadline by a margin, lookups included, but not into the time limit", () => {
    // Never timed: lookups 10 s and the step 30 s, against a deadline plus 45 s.
    expect(fullSyncFirstStepFits("Purchase", now, {}, now)).toBe(true);
    expect(fullSyncFirstStepFits("Purchase", now - 6_000, {}, now)).toBe(false);
    // Timed at 200 s: expected to take 300 s, so it needs 255 s before the deadline.
    expect(fullSyncFirstStepFits("Purchase", now + 250_000, { Purchase: 200_000 }, now)).toBe(false);
    expect(fullSyncFirstStepFits("Purchase", now + 260_000, { Purchase: 200_000, Lookups: 2_000 }, now)).toBe(true);
    expect(fullSyncFirstStepFits("Purchase", undefined, { Purchase: 200_000 }, now)).toBe(true);
  });
});
