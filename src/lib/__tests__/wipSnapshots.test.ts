import { describe, it, expect, vi, beforeEach } from "vitest";
import { FakeModel } from "./support/fakePrisma";

// A small stand-in for the tables the snapshot touches, shaped to its
// queries. Snapshots go in the shared fake's model, which enforces the
// (connectionId, periodEnd) unique key for real.
const db: {
  connections: Record<string, Record<string, any>>;
  jobs: Record<string, any>[];
  snapshots: FakeModel;
  /** Runs once, while the snapshot's figures are being worked out. */
  duringJobRead: null | (() => Promise<void>);
} = { connections: {}, jobs: [], snapshots: new FakeModel("wipSnapshot"), duringJobRead: null };

const pick = (row: Record<string, any>, select?: Record<string, any>) => {
  if (!select) return { ...row };
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(select)) {
    if (v === true) out[k] = row[k];
    else if (k === "connection") out.connection = { emailTimezone: db.connections[row.connectionId].emailTimezone };
  }
  return out;
};

vi.mock("../prisma", () => ({
  prisma: {
    quickBooksConnection: {
      findUnique: async ({ where, select }: any) => (db.connections[where.id] ? pick(db.connections[where.id], select) : null),
      findUniqueOrThrow: async ({ where }: any) => ({ ...db.connections[where.id], marginTargets: [] }),
    },
    job: {
      findMany: async ({ where }: any) => {
        if (db.duringJobRead) {
          const run = db.duringJobRead;
          db.duringJobRead = null;
          await run();
        }
        const rows = db.jobs.filter((j) => j.connectionId === where.connectionId);
        if (where.estimatedCostSource) return rows.filter((j) => j.estimatedCostSource === where.estimatedCostSource).map((j) => ({ id: j.id }));
        return rows.map((j) => ({ ...j, costEntries: [...j.costEntries], invoices: [...j.invoices] }));
      },
    },
    syncRun: { findFirst: async () => null },
    weeklyDigest: { findMany: async () => [] },
    wipSnapshot: {
      create: (args: any) => db.snapshots.create(args),
      updateMany: (args: any) => db.snapshots.updateMany(args),
      findMany: async (args: any) => (await db.snapshots.findMany({ ...args, select: undefined })).map((r: any) => pick(r, args.select)),
    },
  },
}));
vi.mock("../entitlements", () => ({ requireFeature: async () => null }));

import { datedOnOrBefore, getConnectionProfitData, jobRowsAsOf } from "../profitability";
import {
  freezeClosedSnapshots,
  lastEndedPeriodEnd,
  nextSnapshotStep,
  periodEndedAt,
  refreshWindowClosesAt,
  shouldFreeze,
  takeWipSnapshot,
  type ExistingSnapshot,
  type SnapshotCompany,
} from "../wipSnapshots";

const NY = "America/New_York";
const LA = "America/Los_Angeles";
const at = (iso: string) => new Date(iso);
/** A QuickBooks date, stored as UTC midnight of the date (qboDate). */
const day = (ymd: string) => new Date(`${ymd}T00:00:00Z`);
const AUG = day("2026-08-31");
const JUL = day("2026-07-31");
const SEP = day("2026-09-30");

describe("month-end periods follow the company's time zone", () => {
  it("knows which month last ended, and when, in company time", () => {
    // 05:00 UTC on Sep 1 is 1am in New York but still Aug 31 in Los Angeles.
    const now = at("2026-09-01T05:00:00Z");
    expect(lastEndedPeriodEnd(now, NY)).toEqual(AUG);
    expect(lastEndedPeriodEnd(now, LA)).toEqual(JUL);
    expect(periodEndedAt(AUG, NY)).toEqual(at("2026-09-01T04:00:00Z"));
    expect(periodEndedAt(AUG, LA)).toEqual(at("2026-09-01T07:00:00Z"));
  });

  it("refreshes through the 20th of the next month, company time, across a year end", () => {
    expect(refreshWindowClosesAt(AUG, NY)).toEqual(at("2026-09-21T04:00:00Z"));
    expect(lastEndedPeriodEnd(at("2027-01-05T12:00:00Z"), "UTC")).toEqual(day("2026-12-31"));
    expect(refreshWindowClosesAt(day("2026-12-31"), "UTC")).toEqual(at("2027-01-21T00:00:00Z"));
    // Winter time: New York is 5 hours behind in January.
    expect(refreshWindowClosesAt(day("2026-12-31"), NY)).toEqual(at("2027-01-21T05:00:00Z"));
  });
});

describe("as-of figures count only what's dated on or before the period's last day", () => {
  it("counts a cost dated on the last day and not one dated the day after", () => {
    expect(datedOnOrBefore(day("2026-08-31"), AUG)).toBe(true);
    expect(datedOnOrBefore(day("2026-09-01"), AUG)).toBe(false);
    expect(datedOnOrBefore(day("2026-01-15"), AUG)).toBe(true);
  });

  it("drops a job QuickBooks created after the day unless something is dated before it", () => {
    const job = (id: string, created: string, costDates: string[]) => ({
      id,
      qboCreatedAt: at(created),
      costEntries: costDates.map((d) => ({ txnDate: day(d), amount: 1 })),
      invoices: [] as { txnDate: Date }[],
    });
    const rows = jobRowsAsOf(
      [job("old", "2026-05-01T15:00:00Z", ["2026-08-10", "2026-09-02"]), job("new", "2026-09-03T15:00:00Z", ["2026-09-04"]), job("backdated", "2026-09-03T15:00:00Z", ["2026-08-20"])],
      AUG
    );
    expect(rows.map((r) => r.id)).toEqual(["old", "backdated"]);
    expect(rows[0].costEntries.map((c) => c.txnDate)).toEqual([day("2026-08-10")]);
  });
});

function connection(id: string, over: Record<string, any> = {}) {
  db.connections[id] = {
    id,
    userId: "u1",
    emailTimezone: NY,
    // After July ended, so only August can be taken.
    connectedAt: at("2026-08-05T12:00:00Z"),
    disconnectedAt: null,
    lastSyncStatus: "success",
    lastSyncedAt: at("2026-09-02T06:00:00Z"),
    fullSyncContinueAt: null,
    syncVersion: 7,
    laborBurdenPct: 20,
    jobSource: "projects",
    laborFromTimeEntries: true,
    basisChangedAt: at("2026-07-01T00:00:00Z"),
    laborBurdenSetAt: null,
    targetMarginPct: null,
    overheadEnabled: false,
    overheadMethod: null,
    overheadValue: null,
    ...over,
  };
  return db.connections[id];
}

/** A $100,000 contract with an $80,000 cost estimate. */
function kitchenJob(connectionId: string, over: Record<string, any> = {}) {
  const job = {
    id: `${connectionId}-kitchen`,
    connectionId,
    name: "Smith kitchen",
    customerName: "Smith",
    status: "open",
    statusOverride: null,
    category: null,
    estimatedRevenue: 100_000,
    manualContractValue: null,
    estimatedCost: 80_000,
    estimatedCostSource: "manual",
    percentCompleteOverride: null,
    qboCreatedAt: at("2026-06-15T15:00:00Z"),
    startDate: null,
    endDate: null,
    updatedAt: at("2026-09-01T00:00:00Z"),
    costEntries: [] as Record<string, any>[],
    invoices: [] as Record<string, any>[],
    ...over,
  };
  db.jobs.push(job);
  return job;
}
const cost = (ymd: string, amount: number, id = `c-${ymd}-${amount}`) => ({
  qboSourceType: "Bill",
  qboSourceId: id,
  category: "materials",
  amount,
  txnDate: day(ymd),
});
const invoice = (ymd: string, amount: number) => ({ amount, status: "open", txnDate: day(ymd) });

beforeEach(() => {
  db.connections = {};
  db.jobs = [];
  db.snapshots = new FakeModel("wipSnapshot", [{ fields: ["connectionId", "periodEnd"] }]);
  db.duringJobRead = null;
});

describe("getConnectionProfitData with asOf", () => {
  it("leaves out what's dated after the month in the company's time zone, and changes nothing without it", async () => {
    connection("c1");
    const job = kitchenJob("c1");
    // Sep 1 is stored as 00:00 UTC on Sep 1, before New York's August ended
    // (04:00 UTC). It must still not count for August.
    job.costEntries.push(cost("2026-08-31", 40_000), cost("2026-09-01", 20_000));
    job.invoices.push(invoice("2026-08-15", 30_000), invoice("2026-09-01", 50_000));
    const now = at("2026-09-01T05:00:00Z");
    const asOf = lastEndedPeriodEnd(now, NY);

    const monthEnd = await getConnectionProfitData("c1", periodEndedAt(asOf, NY), { asOf });
    expect(monthEnd.lifetimeJobs[0].costs).toBe(40_000);
    expect(monthEnd.lifetimeJobs[0].revenue).toBe(30_000);
    expect(monthEnd.lifetimeJobs[0].wip?.percentComplete).toBe(0.5);
    expect(monthEnd.lifetimeJobs[0].lastFinancialActivity).toEqual(day("2026-08-31"));

    const today = await getConnectionProfitData("c1", now);
    expect(today.lifetimeJobs[0].costs).toBe(60_000);
    expect(today.lifetimeJobs[0].revenue).toBe(80_000);
  });
});

describe("when a month's snapshot is taken, refreshed and frozen", () => {
  const company = (over: Partial<SnapshotCompany> = {}): SnapshotCompany => ({
    connectedAt: at("2026-06-01T12:00:00Z"),
    disconnectedAt: null,
    lastSyncStatus: "success",
    lastSyncedAt: at("2026-09-02T06:00:00Z"),
    fullSyncContinueAt: null,
    paused: false,
    ...over,
  });
  const snap = (periodEnd: Date, takenAt: string, frozenAt: string | null = null): ExistingSnapshot => ({
    periodEnd,
    takenAt: at(takenAt),
    frozenAt: frozenAt ? at(frozenAt) : null,
  });
  const julyDone = snap(JUL, "2026-08-02T06:00:00Z", "2026-08-21T05:00:00Z");

  it("takes the month once it has ended and the company has synced since", () => {
    expect(nextSnapshotStep(at("2026-09-02T07:00:00Z"), NY, company(), [julyDone])).toEqual({ action: "take", periodEnd: AUG, late: false });
  });

  it("refreshes it once a day, by the company's calendar", () => {
    const aug = snap(AUG, "2026-09-02T07:00:00Z");
    const synced = company({ lastSyncedAt: at("2026-09-03T02:00:00Z") });
    // Same New York day (Sep 2, 10pm): already worked out today.
    expect(nextSnapshotStep(at("2026-09-03T02:30:00Z"), NY, synced, [julyDone, aug])).toEqual({ action: "none", reason: "already worked out today" });
    // Taken at 10pm New York time on Sep 2; at 1am on Sep 3 it's a new day
    // there, though still the same UTC day.
    const lateEvening = snap(AUG, "2026-09-03T02:00:00Z");
    expect(nextSnapshotStep(at("2026-09-03T05:00:00Z"), NY, synced, [julyDone, lateEvening])).toEqual({ action: "refresh", periodEnd: AUG });
    expect(nextSnapshotStep(at("2026-09-03T05:00:00Z"), "UTC", synced, [julyDone, lateEvening]).action).toBe("none");
  });

  it("refreshes through the 20th and stops, and a frozen one is never refreshed", () => {
    const aug = snap(AUG, "2026-09-19T12:00:00Z");
    const synced = company({ lastSyncedAt: at("2026-09-20T12:00:00Z") });
    expect(nextSnapshotStep(at("2026-09-21T03:59:00Z"), NY, synced, [julyDone, aug])).toEqual({ action: "refresh", periodEnd: AUG });
    expect(nextSnapshotStep(at("2026-09-21T04:00:00Z"), NY, synced, [julyDone, aug]).action).toBe("none");
    expect(shouldFreeze(aug, at("2026-09-21T03:59:00Z"), NY)).toBe(false);
    expect(shouldFreeze(aug, at("2026-09-21T04:00:00Z"), NY)).toBe(true);

    const frozen = snap(AUG, "2026-09-10T12:00:00Z", "2026-09-10T12:00:00Z");
    expect(nextSnapshotStep(at("2026-09-15T12:00:00Z"), NY, synced, [julyDone, frozen]).action).toBe("none");
    expect(shouldFreeze(frozen, at("2026-10-01T12:00:00Z"), NY)).toBe(false);
  });

  it("takes a missed month late, and only the last one whose window has closed", () => {
    const synced = company({ lastSyncedAt: at("2026-09-25T06:00:00Z") });
    // Past the 20th with no August: taken once, late.
    expect(nextSnapshotStep(at("2026-09-25T07:00:00Z"), NY, synced, [julyDone])).toEqual({ action: "take", periodEnd: AUG, late: true });
    // Early October: September comes first, then August the next night.
    const octSync = company({ lastSyncedAt: at("2026-10-03T06:00:00Z") });
    expect(nextSnapshotStep(at("2026-10-03T07:00:00Z"), NY, octSync, [])).toEqual({ action: "take", periodEnd: SEP, late: false });
    const sep = snap(SEP, "2026-10-02T07:00:00Z");
    expect(nextSnapshotStep(at("2026-10-03T07:00:00Z"), NY, octSync, [sep])).toEqual({ action: "take", periodEnd: AUG, late: true });
    // After September's window closes, August is gone for good.
    const lateOct = company({ lastSyncedAt: at("2026-10-25T06:00:00Z") });
    expect(nextSnapshotStep(at("2026-10-25T07:00:00Z"), NY, lateOct, [snap(SEP, "2026-10-20T07:00:00Z")]).action).toBe("none");
  });

  it("only for connected, unpaused companies synced after the month ended and connected before it", () => {
    const now = at("2026-09-02T07:00:00Z");
    const step = (over: Partial<SnapshotCompany>) => nextSnapshotStep(now, NY, company(over), [julyDone]).action;
    expect(step({})).toBe("take");
    expect(step({ disconnectedAt: at("2026-09-01T12:00:00Z") })).toBe("none");
    expect(step({ paused: true })).toBe("none");
    expect(step({ lastSyncStatus: "error" })).toBe("none");
    expect(step({ fullSyncContinueAt: at("2026-09-02T06:30:00Z") })).toBe("none");
    // Connected after August ended (New York time).
    expect(step({ connectedAt: at("2026-09-01T04:30:00Z") })).toBe("none");
    // Last sync started before August ended in New York (11:30pm Aug 31).
    expect(step({ lastSyncedAt: at("2026-09-01T03:30:00Z") })).toBe("none");
  });
});

describe("taking, refreshing and freezing snapshots", () => {
  const stored = async (connectionId: string) => (await db.snapshots.findMany({ where: { connectionId } }))[0];

  it("stores the schedule as of the month's end with the basis it was worked out on, and refreshes it", async () => {
    connection("c1");
    const job = kitchenJob("c1");
    job.costEntries.push(cost("2026-08-31", 40_000), cost("2026-09-01", 20_000));
    job.invoices.push(invoice("2026-08-15", 30_000));

    const first = await takeWipSnapshot("c1", { paused: false, now: at("2026-09-02T07:00:00Z") });
    expect(first).toEqual({ connectionId: "c1", status: "taken", detail: "2026-08" });
    const s = await stored("c1");
    expect(s.periodEnd).toEqual(AUG);
    expect(s.takenLate).toBe(false);
    expect(s.frozenAt).toBeNull();
    expect({ v: s.syncVersion, b: s.laborBurdenPct, j: s.jobSource, t: s.laborFromTimeEntries, c: s.basisChangedAt, l: s.laborBurdenSetAt }).toEqual({
      v: 7,
      b: 20,
      j: "projects",
      t: true,
      c: at("2026-07-01T00:00:00Z"),
      l: null,
    });
    expect(s.inProgress).toHaveLength(1);
    expect(s.inProgress[0]).toMatchObject({
      jobId: "c1-kitchen",
      jobName: "Smith kitchen",
      customerName: "Smith",
      contract: 100_000,
      estimatedTotalCost: 80_000,
      estimatedGrossProfit: 20_000,
      costToDate: 40_000,
      percentComplete: 0.5,
      percentFromEntry: false,
      earnedRevenue: 50_000,
      billedToDate: 30_000,
      overBilled: 0,
      underBilled: 20_000,
      costToComplete: 40_000,
      grossProfitToDate: 10_000,
      provisionForLoss: 0,
    });
    expect(s.totals).toMatchObject({ contract: 100_000, costToDate: 40_000, underBilled: 20_000 });
    expect(s.notScheduled).toEqual([]);
    expect(s.completedTotals).toEqual({ revenue: 0, cost: 0, grossProfit: 0, margin: null });
    expect(s.completed).toEqual([]);
    expect(s.idle).toEqual([]);

    // The bookkeeper enters a late August bill; the next day's refresh counts it.
    job.costEntries.push(cost("2026-08-28", 8_000));
    db.connections.c1.lastSyncedAt = at("2026-09-03T06:00:00Z");
    expect((await takeWipSnapshot("c1", { paused: false, now: at("2026-09-03T07:00:00Z") })).status).toBe("refreshed");
    expect((await stored("c1")).inProgress[0].costToDate).toBe(48_000);
    // Once a day: a second run the same day works nothing out.
    expect((await takeWipSnapshot("c1", { paused: false, now: at("2026-09-03T20:00:00Z") })).status).toBe("skipped");
  });

  it("freezes on time in each company's zone and never changes a frozen snapshot", async () => {
    connection("ny");
    connection("la", { emailTimezone: LA });
    for (const id of ["ny", "la"]) {
      kitchenJob(id).costEntries.push(cost("2026-08-31", 40_000));
      expect((await takeWipSnapshot(id, { paused: false, now: at("2026-09-02T09:00:00Z") })).status).toBe("taken");
    }
    // 1am Sep 21 in New York, 10pm Sep 20 in Los Angeles.
    expect(await freezeClosedSnapshots(at("2026-09-21T05:00:00Z"))).toBe(1);
    const ny = await stored("ny");
    expect(ny.frozenAt).toEqual(at("2026-09-21T05:00:00Z"));
    expect((await stored("la")).frozenAt).toBeNull();
    const frozenCopy = JSON.parse(JSON.stringify(ny));

    // Later entries dated in August, a new sync, the next night: untouched.
    db.jobs.find((j) => j.connectionId === "ny")!.costEntries.push(cost("2026-08-30", 9_000));
    db.connections.ny.lastSyncedAt = at("2026-09-22T06:00:00Z");
    expect((await takeWipSnapshot("ny", { paused: false, now: at("2026-09-22T07:00:00Z") })).status).toBe("skipped");
    expect(await freezeClosedSnapshots(at("2026-09-23T05:00:00Z"))).toBe(1); // only Los Angeles
    expect(JSON.parse(JSON.stringify(await stored("ny")))).toEqual(frozenCopy);
  });

  it("leaves a snapshot alone that was frozen while its refresh was being worked out", async () => {
    connection("c1");
    kitchenJob("c1").costEntries.push(cost("2026-08-31", 40_000));
    await takeWipSnapshot("c1", { paused: false, now: at("2026-09-19T12:00:00Z") });
    const before = JSON.parse(JSON.stringify(await stored("c1")));

    db.jobs[0].costEntries.push(cost("2026-08-29", 5_000));
    db.connections.c1.lastSyncedAt = at("2026-09-20T12:00:00Z");
    db.duringJobRead = async () => {
      await db.snapshots.updateMany({ where: { connectionId: "c1" }, data: { frozenAt: at("2026-09-20T12:30:00Z") } });
    };
    expect(await takeWipSnapshot("c1", { paused: false, now: at("2026-09-20T13:00:00Z") })).toEqual({
      connectionId: "c1",
      status: "skipped",
      detail: "2026-08 is frozen",
    });
    const after = await stored("c1");
    expect(after.inProgress[0].costToDate).toBe(40_000);
    expect(after.takenAt).toEqual(new Date(before.takenAt));
  });

  it("takes a missed month once, frozen at once and marked late", async () => {
    connection("c1", { lastSyncedAt: at("2026-09-28T06:00:00Z") });
    kitchenJob("c1").costEntries.push(cost("2026-08-31", 40_000), cost("2026-09-10", 7_000));
    expect(await takeWipSnapshot("c1", { paused: false, now: at("2026-09-28T07:00:00Z") })).toEqual({
      connectionId: "c1",
      status: "taken",
      detail: "2026-08, late and frozen",
    });
    const s = await stored("c1");
    expect(s.takenLate).toBe(true);
    expect(s.frozenAt).toEqual(s.takenAt);
    expect(s.inProgress[0].costToDate).toBe(40_000);
    const copy = JSON.parse(JSON.stringify(s));

    db.connections.c1.lastSyncedAt = at("2026-09-29T06:00:00Z");
    expect((await takeWipSnapshot("c1", { paused: false, now: at("2026-09-29T07:00:00Z") })).status).toBe("skipped");
    expect(await db.snapshots.count({ where: { connectionId: "c1" } })).toBe(1);
    expect(JSON.parse(JSON.stringify(await stored("c1")))).toEqual(copy);
  });

  it("stores each completed contract and each idle job, as of the month's end", async () => {
    connection("c1");
    kitchenJob("c1").costEntries.push(cost("2026-08-31", 40_000));
    // Finished in August. A September refund bill doesn't count for August.
    const deck = kitchenJob("c1", { id: "c1-deck", name: "Jones deck", customerName: "Jones", status: "closed", estimatedRevenue: 20_000 });
    deck.costEntries.push(cost("2026-08-10", 12_000), cost("2026-09-05", -1_000));
    deck.invoices.push(invoice("2026-08-20", 20_000));
    // Open, measurable, and nothing posted since May: idle at the end of August.
    const barn = kitchenJob("c1", { id: "c1-barn", name: "Old barn", customerName: "Lee" });
    barn.costEntries.push(cost("2026-05-01", 10_000));
    barn.invoices.push(invoice("2026-05-01", 12_000));

    expect((await takeWipSnapshot("c1", { paused: false, now: at("2026-09-02T07:00:00Z") })).status).toBe("taken");
    const s = await stored("c1");
    expect(s.inProgress.map((r: { jobId: string }) => r.jobId)).toEqual(["c1-kitchen"]);
    expect(s.completed).toEqual([
      { jobId: "c1-deck", jobName: "Jones deck", customerName: "Jones", revenue: 20_000, cost: 12_000, grossProfit: 8_000, margin: 0.4 },
    ]);
    expect(s.completedTotals).toEqual({ revenue: 20_000, cost: 12_000, grossProfit: 8_000, margin: 0.4 });
    expect(s.idle).toEqual([{ jobId: "c1-barn", jobName: "Old barn" }]);
  });

  it("takes nothing for a paused company", async () => {
    connection("c1");
    kitchenJob("c1").costEntries.push(cost("2026-08-31", 40_000));
    expect(await takeWipSnapshot("c1", { paused: true, now: at("2026-09-02T07:00:00Z") })).toEqual({
      connectionId: "c1",
      status: "skipped",
      detail: "paused: past the plan's company limit",
    });
    expect(await db.snapshots.count()).toBe(0);
  });
});
